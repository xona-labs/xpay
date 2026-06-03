/**
 * LLM tool-definition exporters.
 *
 * Each helper returns the tool/function-calling schema in the vendor's
 * preferred shape plus a `handlers` map. Wire them into your agent loop:
 *
 *   const { tools, handlers } = forClaude(xpay);
 *   // pass `tools` to Anthropic, look up `handlers[name]` on tool_use blocks.
 *
 * The tool surface mirrors the CLI commands so an agent's mental model is
 * the same whether it's calling the SDK, the CLI, or MCP.
 */

import type { XPay } from "../index.js";
import { forSana } from "../sana/tools.js";

export interface ToolBundle<TDef> {
  tools: TDef[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}

export interface ClaudeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolOptions {
  /** Sana API key — when present, registers sana_* tools alongside xpay_* tools. */
  sanaApiKey?: string;
}

/** Anthropic Claude tool definitions. */
export function forClaude(xpay: XPay, opts: ToolOptions = {}): ToolBundle<ClaudeToolDef> {
  const tools: ClaudeToolDef[] = [
    {
      name: "xpay_discover",
      description:
        "Find paid HTTP services across the agentic-commerce catalog (PayAI + others). " +
        "Returns ranked candidates with price, network, and payment recipient.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to find, in natural language." },
          limit: { type: "number", description: "Max results. Default 5." },
          network: { type: "string", description: "Restrict to one network (solana, base, ...)." },
        },
        required: ["query"],
      },
    },
    {
      name: "xpay_use",
      description:
        "Call a specific resource (by URL) from the catalog. Handles x402 payment automatically.",
      input_schema: {
        type: "object",
        properties: {
          resourceUrl: { type: "string", description: "URL of the resource to call." },
          body: { type: "object", description: "Optional JSON body for POST endpoints." },
        },
        required: ["resourceUrl"],
      },
    },
    {
      name: "xpay_do",
      description:
        "Discover the best service for an intent and call it in one step. " +
        "Use this when you don't need to compare options first.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          body: { type: "object" },
        },
        required: ["query"],
      },
    },
    {
      name: "xpay_transfer",
      description:
        "Send USDC directly to an address (no x402, no provider). Subject to the user's guardrail.",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "USDC amount in human units, e.g. 1.5 for $1.50." },
          to: { type: "string", description: "Recipient address (Solana base58 or EVM 0x...)." },
          network: { type: "string", description: "Force network if address is ambiguous." },
        },
        required: ["amount", "to"],
      },
    },
    {
      name: "xpay_balance",
      description: "USDC balance on each configured network, plus a total.",
      input_schema: {
        type: "object",
        properties: {
          network: { type: "string", description: "Restrict to one network." },
        },
      },
    },
    {
      name: "xpay_history",
      description:
        "Recent USDC activity across all configured networks (send + receive), sorted newest first.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries. Default 25." },
          network: { type: "string", description: "Restrict to one network." },
        },
      },
    },
    {
      name: "xpay_guardrail",
      description: "Read the active spending guardrail (caps, allowed hosts, approval threshold).",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const handlers: ToolBundle<ClaudeToolDef>["handlers"] = {
    xpay_discover: async (input) =>
      xpay.discover({
        query: input.query as string,
        limit: (input.limit as number) ?? 5,
        networks: input.network ? [input.network as string] : undefined,
      }),

    xpay_use: async (input) => {
      const url = input.resourceUrl as string;
      return xpay.useByUrl(url, { body: input.body as unknown });
    },

    xpay_do: async (input) =>
      xpay.do(input.query as string, { body: input.body as unknown }),

    xpay_transfer: async (input) =>
      xpay.transfer({
        amount: input.amount as number,
        to: input.to as string,
        network: input.network as string | undefined,
        token: "USDC",
      }),

    xpay_balance: async (input) => {
      const networks = input.network
        ? [input.network as string]
        : xpay.wallet.networks;
      const out: Record<string, number> = {};
      let total = 0;
      for (const n of networks) {
        const b = await xpay.wallet.balance(n);
        out[n] = b;
        total += b;
      }
      return { perNetwork: out, totalUsdc: total };
    },

    xpay_history: async (input) =>
      xpay.history({
        limit: (input.limit as number) ?? 25,
        networks: input.network ? [input.network as string] : undefined,
      }),

    xpay_guardrail: async () => xpay.guardrail,
  };

  // Merge Sana tools if an API key is configured.
  if (opts.sanaApiKey) {
    const sana = forSana(opts.sanaApiKey);
    return {
      tools: [...tools, ...sana.tools],
      handlers: { ...handlers, ...sana.handlers },
    };
  }

  return { tools, handlers };
}

/** OpenAI function-calling tool definitions (derived from the Claude shape). */
export function forOpenAI(xpay: XPay) {
  const claude = forClaude(xpay);
  return {
    tools: claude.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    handlers: claude.handlers,
  };
}

/** Google Gemini function-declaration definitions. */
export function forGemini(xpay: XPay) {
  const claude = forClaude(xpay);
  return {
    tools: [
      {
        functionDeclarations: claude.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ],
    handlers: claude.handlers,
  };
}
