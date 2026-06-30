/**
 * xPay MCP server.
 *
 * Exposes every CLI capability as an MCP tool over stdio. Zero-config — drop
 * this into any Claude Desktop / Cursor / Codex / agent-framework config and
 * on first boot the agent is given its own persistent wallet:
 *
 *   {
 *     "mcpServers": {
 *       "xpay": {
 *         "command": "npx",
 *         "args": ["-y", "@xona-labs/xpay", "mcp"]
 *       }
 *     }
 *   }
 *
 * The generated wallet's address is printed to stderr on first run — fund the
 * Solana address with USDC to let the agent pay. It persists under ~/.xpay and
 * is reused on every later boot.
 *
 * Configuration via env (all optional):
 *   XPAY_PROFILE        profile to load/create (default: active, else "default")
 *   XPAY_PASSPHRASE     encrypt the wallet at rest (also unlocks an existing one)
 *   XPAY_HOME           override ~/.xpay/ root (mirrors the CLI)
 *   XPAY_NO_AUTO_WALLET error instead of auto-generating when nothing is configured
 *
 * To use a wallet you already hold instead of a generated one:
 *   XPAY_SOLANA_SECRET, XPAY_EVM_KEY, XPAY_EVM_NETWORK
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createXPay, loadProfile, initProfile, deriveKeysFromMnemonic } from "../index.js";
import { profileExists } from "../profile/storage.js";
import { readProfileConfig, setProfileBento } from "../profile/index.js";
import { rawSolanaSigner } from "../signers/raw-solana.js";
import { rawEvmSigner } from "../signers/raw-evm.js";
import { forClaude } from "../tools/index.js";
import { getActiveProfile } from "./accounts.js";
import { guardrailWithApproval } from "./common.js";
import type { Network, Signer } from "../types.js";
import type { XPay } from "../index.js";

export async function startMcpServer(): Promise<void> {
  const { xpay, profileName } = await buildXPay();
  const sanaApiKey = await resolveSanaApiKey();
  const { tools, handlers } = forClaude(xpay, { sanaApiKey });

  // Note: xpay_transfer executes directly (via the forClaude handler) — the same
  // path as the CLI. We deliberately do NOT stage transfers behind a second
  // "confirm" tool call: that relied on the agent faithfully making a follow-up
  // call, which weaker models skip while hallucinating a success + fake tx hash.
  // The real spending gate is the guardrail (caps + requireApprovalAbove), which
  // surfaces as a Touch ID prompt on MCP when biometric unlock is enabled — a
  // gate the model can't fake or skip.

  const mcpTools = [
    ...tools,
    {
      name: "xpay_bento_status",
      description:
        "Check whether the Bento intent firewall is active. When on, every payment is " +
        "screened for malicious intent (prompt-injection, wallet-drain) before signing. Read-only.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "xpay_bento_enable",
      description:
        "Turn ON the Bento intent firewall for this agent's wallet. Returns the agent wallet " +
        "address, which must be registered once at app.bentoguard.xyz (logging in with the " +
        "owner wallet) before protection takes effect — until then payments are rejected.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "xpay_bento_disable",
      description:
        "Turn OFF the Bento intent firewall. Use this if the wallet isn't registered at the " +
        "Bento dashboard and payments are being rejected with 'Agent not found'. Payments then " +
        "fall back to the local spending caps only.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  // --- MCP-only: Bento intent firewall controls ---
  // status + enable + disable. Disable is intentionally available so the agent
  // can recover when the wallet isn't registered and payments are rejected.
  const BENTO_DASHBOARD = "https://app.bentoguard.xyz/";
  const agentSolanaAddress = (): string => {
    try {
      return xpay.wallet.address("solana");
    } catch {
      return "";
    }
  };

  handlers["xpay_bento_status"] = async () => {
    const persisted = profileName ? Boolean(readProfileConfig(profileName).bento?.enabled) : false;
    return {
      enabled: xpay.guardrail.bentoEnabled(),
      persisted,
      profileBacked: Boolean(profileName),
      agentWallet: agentSolanaAddress(),
      dashboard: BENTO_DASHBOARD,
    };
  };

  handlers["xpay_bento_enable"] = async () => {
    if (!profileName) {
      return {
        ok: false,
        error:
          "Bento requires a profile-backed wallet. This server is running with a raw key " +
          "(XPAY_SOLANA_SECRET), so there's no profile to enable it on.",
      };
    }
    setProfileBento(profileName, true); // persist for future boots
    xpay.guardrail.setBentoEnabled(true); // activate for this session
    return {
      ok: true,
      enabled: true,
      agentWallet: agentSolanaAddress(),
      action_required:
        `Register this agent wallet at ${BENTO_DASHBOARD} (log in with your owner wallet). ` +
        `Until it's registered, payments are rejected with "Agent not found" — call ` +
        `xpay_bento_disable to fall back to local caps if you don't want to register.`,
    };
  };

  handlers["xpay_bento_disable"] = async () => {
    if (profileName) setProfileBento(profileName, false); // persist
    xpay.guardrail.setBentoEnabled(false); // deactivate for this session
    return {
      ok: true,
      enabled: false,
      note: "Bento intent screening is off. Payments now rely on the local spending caps only.",
    };
  };
  // --- end Bento controls ---

  const server = new Server(
    { name: "xpay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: "input_schema" in t ? t.input_schema : t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = handlers[req.params.name];
    if (!handler) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    try {
      const result = await handler(req.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Build the XPay client the MCP host will use. Preference order:
 *   1. A loaded profile (the common case after `xpay init`).
 *   2. Raw signer envs (for a wallet the operator already holds).
 *   3. Auto-provision a fresh wallet (zero-config onboarding) and persist it.
 */
async function buildXPay(): Promise<{ xpay: XPay; profileName: string | null }> {
  const profileName = process.env.XPAY_PROFILE ?? getActiveProfile();
  if (profileExists(profileName)) {
    const profile = await loadProfile({
      name: profileName,
      passphrase: process.env.XPAY_PASSPHRASE ?? (await biometricMcpPassphrase(profileName)),
    });
    // Expose the agent's own key so a runtime `xpay_bento_enable` can activate
    // protect() without a restart. In-process only; it's the wallet's own key.
    process.env.AGENT_WALLET_PRIVATE_KEY ??= deriveKeysFromMnemonic(profile.mnemonic).solana.secretKeyBase58;
    // No TTY here — approvals above the guardrail threshold surface as a
    // system Touch ID dialog when the profile has biometric unlock enabled.
    const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile, { interactive: false }) });
    return { xpay, profileName };
  }

  // Fallback: ephemeral raw signers.
  const networks = (process.env.XPAY_NETWORKS ?? "solana,base").split(",") as Network[];
  const signers: Partial<Record<Network, Signer>> = {};
  if (process.env.XPAY_SOLANA_SECRET) {
    signers["solana"] = rawSolanaSigner({ secretKey: process.env.XPAY_SOLANA_SECRET });
  }
  if (process.env.XPAY_EVM_KEY) {
    const evmNet = (process.env.XPAY_EVM_NETWORK ?? "base") as Network;
    signers[evmNet] = rawEvmSigner({ privateKey: process.env.XPAY_EVM_KEY, network: evmNet });
  }
  if (Object.keys(signers).length === 0) {
    // Nothing configured — give the agent its own wallet (zero-config
    // onboarding). Opt out with XPAY_NO_AUTO_WALLET for the strict behaviour.
    if (!process.env.XPAY_NO_AUTO_WALLET) {
      return autoProvisionXPay(profileName);
    }
    throw new Error(
      `xpay-mcp: no profile "${profileName}" found and no raw signer env set. ` +
        `Run \`xpay init\`, set XPAY_SOLANA_SECRET / XPAY_EVM_KEY, or unset ` +
        `XPAY_NO_AUTO_WALLET to auto-generate a wallet.`,
    );
  }
  // Raw-key mode: no profile on disk, so bento's profile-gated flag can't be
  // toggled — profileName is null and the bento tools report that.
  const xpay = createXPay({
    networks,
    signers,
    guardrail: {
      maxPerTx: numericEnv("XPAY_MAX_PER_TX"),
      maxPerDay: numericEnv("XPAY_MAX_PER_DAY"),
      allowedHosts: process.env.XPAY_ALLOWED_HOSTS?.split(","),
    },
  });
  return { xpay, profileName: null };
}

/**
 * Zero-config onboarding: no profile and no key configured, so generate a
 * fresh wallet for the agent, persist it under ~/.xpay (or XPAY_HOME), and
 * surface the address. Encrypted when XPAY_PASSPHRASE is set, otherwise
 * plaintext (file-permission protected) — fine for a low-balance agent wallet.
 *
 * Runs once: the next boot finds the profile and loads it via the normal path,
 * so the agent keeps the same address across restarts. All notices go to
 * stderr — stdout is the MCP JSON-RPC channel and must stay clean.
 */
async function autoProvisionXPay(profileName: string): Promise<{ xpay: XPay; profileName: string }> {
  const passphrase = process.env.XPAY_PASSPHRASE || undefined;
  const created = await initProfile({ name: profileName, passphrase });

  process.stderr.write(
    `\n[xpay-mcp] No wallet found — generated one for this agent.\n` +
      `[xpay-mcp]   profile:  ${profileName}\n` +
      `[xpay-mcp]   Solana:   ${created.addresses.solana}\n` +
      `[xpay-mcp]   Base/EVM: ${created.addresses.evm}\n` +
      `[xpay-mcp]   stored:   ${created.path}` +
      (passphrase ? " (encrypted)\n" : " (UNENCRYPTED — set XPAY_PASSPHRASE to encrypt at rest)\n") +
      `[xpay-mcp] Fund the Solana address with USDC so the agent can pay.\n` +
      `[xpay-mcp] The recovery phrase lives in ${created.path} — back it up.\n\n`,
  );

  const profile = await loadProfile({ name: profileName, passphrase });
  process.env.AGENT_WALLET_PRIVATE_KEY ??= deriveKeysFromMnemonic(profile.mnemonic).solana.secretKeyBase58;
  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile, { interactive: false }) });
  return { xpay, profileName };
}

/**
 * Resolve the Sana API key. Preference:
 *   1. Profile config.json → sana.apiKey  (set via `xpay sana link`)
 *   2. Env SANABOT_API_KEY                (standard Sana env var)
 */
async function resolveSanaApiKey(): Promise<string | undefined> {
  try {
    const profileName = process.env.XPAY_PROFILE ?? getActiveProfile();
    // config.json is plaintext — no need to unlock the wallet to read it.
    const { readProfileConfig } = await import("../profile/index.js");
    const key = readProfileConfig(profileName).sana?.apiKey;
    if (key) return key;
  } catch {
    // profile not found — fall through to env
  }
  return process.env.SANABOT_API_KEY || undefined;
}

/**
 * Touch ID unlock at MCP startup — lets hosts omit XPAY_PASSPHRASE from
 * their config when the profile has `xpay biometric enable` set. Shows one
 * system dialog as the server boots; resolves undefined on any failure so
 * loadProfile produces its normal "passphrase required" error.
 */
async function biometricMcpPassphrase(profileName: string): Promise<string | undefined> {
  try {
    const { readProfileConfig } = await import("../profile/index.js");
    if (!readProfileConfig(profileName).biometric?.enabled) return undefined;
    const { readBiometricPassphrase } = await import("../biometric/index.js");
    return (
      (await readBiometricPassphrase(profileName, `unlock the xPay profile "${profileName}"`)) ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function numericEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
