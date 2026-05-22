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

export async function startMcpServer(): Promise<void> {
  const xpay = await buildXPay();
  const { tools, handlers } = forClaude(xpay);

  const server = new Server(
    { name: "xpay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
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

function numericEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
