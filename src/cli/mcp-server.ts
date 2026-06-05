/**
 * xPay MCP server.
 *
 * Exposes every CLI capability as an MCP tool over stdio. Designed to be
 * dropped into Claude Desktop / Cursor / Codex configs verbatim:
 *
 *   {
 *     "mcpServers": {
 *       "xpay": {
 *         "command": "npx",
 *         "args": ["-y", "@xona-labs/xpay"],
 *         "env": { "XPAY_PASSPHRASE": "<your-passphrase>" }
 *       }
 *     }
 *   }
 *
 * Configuration via env:
 *   XPAY_PROFILE     profile to load (default: active profile, else "default")
 *   XPAY_PASSPHRASE  passphrase for encrypted wallets
 *   XPAY_HOME        override ~/.xpay/ root (mirrors the CLI)
 *
 * For ephemeral / test setups you can still bypass profiles with:
 *   XPAY_SOLANA_SECRET, XPAY_EVM_KEY, XPAY_EVM_NETWORK
 */

import { randomInt } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createXPay, loadProfile } from "../index.js";
import { profileExists } from "../profile/storage.js";
import { rawSolanaSigner } from "../signers/raw-solana.js";
import { rawEvmSigner } from "../signers/raw-evm.js";
import { forClaude } from "../tools/index.js";
import { getActiveProfile } from "./accounts.js";
import type { Network, Signer } from "../types.js";
import type { XPay } from "../index.js";

interface PendingTransfer {
  amount: number;
  to: string;
  token?: string;
  network?: string;
  private?: boolean;
  expiresAt: number;
}

/** Pending transfers waiting for user confirmation. Keyed by 6-digit code. */
const pendingTransfers = new Map<string, PendingTransfer>();
const TRANSFER_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export async function startMcpServer(): Promise<void> {
  const xpay = await buildXPay();
  const sanaApiKey = await resolveSanaApiKey();
  const { tools, handlers } = forClaude(xpay, { sanaApiKey });

  // --- MCP-only: two-step confirmation for transfers ---
  // Override xpay_transfer to stage a pending request instead of executing immediately.
  // xpay_transfer_confirm (defined below) is the only path that actually moves funds.
  // The CLI is unaffected — it uses its own inquirer confirm in cli/transfer.ts.
  handlers["xpay_transfer"] = async (input) => {
    const amount = input.amount as number;
    const to = input.to as string;
    const token = (input.token as string | undefined) ?? "USDC";
    const network = input.network as string | undefined;
    const isPrivate = input.private as boolean | undefined;

    // Purge any expired codes before generating a new one.
    const now = Date.now();
    for (const [k, v] of pendingTransfers) {
      if (v.expiresAt < now) pendingTransfers.delete(k);
    }

    let code: string;
    do {
      code = String(randomInt(100000, 999999));
    } while (pendingTransfers.has(code));

    pendingTransfers.set(code, {
      amount,
      to,
      token,
      network,
      private: isPrivate,
      expiresAt: now + TRANSFER_EXPIRY_MS,
    });

    const summary = `${amount} ${token} → ${to}${network ? ` on ${network}` : ""}${isPrivate ? " (private)" : ""}`;
    return {
      status: "pending_confirmation",
      summary,
      message:
        `Transfer staged: ${summary}. ` +
        `To authorise, call xpay_transfer_confirm with confirmationCode: "${code}". ` +
        `Code expires in 5 minutes. Do NOT proceed unless you initiated this request.`,
    };
  };

  const mcpTools = [
    ...tools,
    {
      name: "xpay_transfer_confirm",
      description:
        "Confirm and execute a staged transfer. " +
        "Call this only after xpay_transfer returns a confirmationCode and the user explicitly approves the transfer details.",
      inputSchema: {
        type: "object",
        properties: {
          confirmationCode: {
            type: "string",
            description: "The 6-digit code returned by xpay_transfer.",
          },
        },
        required: ["confirmationCode"],
      },
    },
  ];

  handlers["xpay_transfer_confirm"] = async (input) => {
    const code = String(input.confirmationCode ?? "").trim();
    const pending = pendingTransfers.get(code);

    if (!pending) {
      throw new Error(
        "Invalid or expired confirmation code. Call xpay_transfer again to get a new code.",
      );
    }
    if (pending.expiresAt < Date.now()) {
      pendingTransfers.delete(code);
      throw new Error("Confirmation code has expired. Call xpay_transfer again to stage a new transfer.");
    }

    pendingTransfers.delete(code);
    return xpay.transfer({
      amount: pending.amount,
      to: pending.to,
      token: pending.token,
      network: pending.network as Network | undefined,
      private: pending.private,
    });
  };
  // --- end MCP-only confirmation ---

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
 *   2. Raw signer envs (for tests / ephemeral pods that skip the profile flow).
 */
async function buildXPay(): Promise<XPay> {
  const profileName = process.env.XPAY_PROFILE ?? getActiveProfile();
  if (profileExists(profileName)) {
    const profile = await loadProfile({
      name: profileName,
      passphrase: process.env.XPAY_PASSPHRASE,
    });
    return createXPay({ profile });
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
    throw new Error(
      `xpay-mcp: no profile "${profileName}" found and no raw signer env set. ` +
        `Run \`xpay init\` first, or set XPAY_SOLANA_SECRET / XPAY_EVM_KEY.`,
    );
  }
  return createXPay({
    networks,
    signers,
    guardrail: {
      maxPerTx: numericEnv("XPAY_MAX_PER_TX"),
      maxPerDay: numericEnv("XPAY_MAX_PER_DAY"),
      allowedHosts: process.env.XPAY_ALLOWED_HOSTS?.split(","),
    },
  });
}

/**
 * Resolve the Sana API key. Preference:
 *   1. Profile config.json → sana.apiKey  (set via `xpay sana link`)
 *   2. Env SANABOT_API_KEY                (standard Sana env var)
 */
async function resolveSanaApiKey(): Promise<string | undefined> {
  try {
    const profileName = process.env.XPAY_PROFILE ?? getActiveProfile();
    const profile = await loadProfile({
      name: profileName,
      passphrase: process.env.XPAY_PASSPHRASE,
    });
    if (profile.config.sana?.apiKey) return profile.config.sana.apiKey;
  } catch {
    // profile not found or locked — fall through to env
  }
  return process.env.SANABOT_API_KEY || undefined;
}

function numericEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
