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
import { ResourceSchema } from "../types.js";
import { fetchAgencTask } from "../agenc/api.js";
import { enrichTokenBalances } from "../token/index.js";
import { forSana } from "../sana/tools.js";
import {
  ZAUTH_BASE,
  isScanPending,
  isScanning,
  pollRepoScan,
  fetchScanStatus,
  compactScanReport,
} from "../zauth/index.js";

/** Base URL for xona's paid X (Twitter) data endpoints (x402-gated). */
const XDATA_BASE = process.env.XPAY_XDATA_ENDPOINT ?? "https://api.xona-agent.com";

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
        "Returns ranked candidates with price, network, and payment recipient. " +
        "Results may include AgenC marketplace agent listings (metadata.source === 'agenc') — " +
        "those are priced in SOL lamports and execute as on-chain escrow hires, not HTTP calls. " +
        "When the user asks specifically about the AgenC marketplace, pass sources: ['agenc'] " +
        "(optionally with no query) to list ALL its listings instead of the few slots it gets " +
        "in mixed results.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to find, in natural language. Omit to browse a whole source." },
          limit: { type: "number", description: "Max results. Default 5." },
          network: { type: "string", description: "Restrict to one network (solana, base, ...)." },
          sources: {
            type: "array",
            items: { type: "string", enum: ["orbitx402", "agenc"] },
            description: "Restrict to specific catalogs, e.g. ['agenc'] for AgenC marketplace only. Default: all.",
          },
        },
      },
    },
    {
      name: "xpay_use",
      description:
        "Call a specific resource from the catalog. Handles x402 payment automatically. " +
        "Prefer passing the full `resource` object returned by xpay_discover — it includes " +
        "pre-fetched payment requirements so payment goes through without a probe round-trip. " +
        "Fall back to `resourceUrl` only when you have a URL but no catalog entry. " +
        "If the resource is an AgenC marketplace listing it executes as a Solana escrow hire " +
        "instead: SOL is escrowed on-chain and the result is a hire receipt (task PDA + tx " +
        "signature), NOT an HTTP response — the provider works asynchronously; poll progress " +
        "with xpay_agenc_status.",
      input_schema: {
        type: "object",
        properties: {
          resource: {
            type: "object",
            description:
              "Full resource object from xpay_discover (preferred). " +
              "Must include `resource` (URL), `type`, `method`, and `accepts` fields.",
          },
          resourceUrl: {
            type: "string",
            description:
              "URL of the resource to call. Used only when `resource` object is not available.",
          },
          body: { type: "object", description: "Optional JSON body for POST endpoints." },
        },
      },
    },
    {
      name: "xpay_do",
      description:
        "Discover the best service for an intent and call it in one step. " +
        "Use this when you don't need to compare options first. " +
        "If the best match is an AgenC listing, it executes as an async SOL escrow hire " +
        "and returns a hire receipt (see xpay_use).",
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
        "Send tokens directly to an address (no x402, no provider). Subject to the user's guardrail. " +
        "Solana supports any SPL token: USDC, USDT, wSOL, mSOL, JitoSOL, BONK, JUP, PYTH, or any mint address. " +
        "EVM supports USDC only. " +
        "Pass private:true on Solana to route through MagicBlock's Private Ephemeral Rollup, " +
        "which obscures the amount and recipient via delayed execution + fund splitting.",
      input_schema: {
        type: "object",
        properties: {
          amount:  { type: "number",  description: "Token amount in human units, e.g. 1.5 or 1000." },
          to:      { type: "string",  description: "Recipient address (Solana base58 or EVM 0x...)." },
          token:   { type: "string",  description: "Token symbol (USDC, BONK, JUP, wSOL, …) or Solana mint address. Defaults to USDC." },
          network: { type: "string",  description: "Force network if address is ambiguous." },
          private: { type: "boolean", description: "Route through MagicBlock Private Ephemeral Rollup for on-chain privacy (Solana only)." },
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
      name: "xpay_report",
      description:
        "Comprehensive USDC activity report for the wallet — totals, net flow, daily timeline, top counterparties, and biggest transactions. " +
        "Powered by OrbitX402 (on-chain data fetched server-side, no RPC exposed). " +
        "Use this instead of history for a full picture of spending and income.",
      input_schema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["daily", "weekly", "monthly"],
            description: "Report window. Default: weekly.",
          },
          network: {
            type: "string",
            description: "Network to report on. Default: solana.",
          },
        },
      },
    },
    {
      name: "xpay_guardrail",
      description: "Read the active spending guardrail (caps, allowed hosts, approval threshold).",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "xpay_token_find",
      description:
        "Find Solana tokens by ticker, name, or mint address (Jupiter registry). Read-only — no " +
        "wallet, no spending. Returns mint, price, market cap, liquidity, and a `verified` flag. " +
        "ALWAYS check `verified` before suggesting a swap: unverified tokens can be scams reusing a " +
        "real token's ticker. This tool alone answers price/info questions — only proceed to a swap " +
        "if the user explicitly asked to trade, and then use the xpay_swap tool with the chosen mint " +
        "(do NOT write code or call DEX APIs yourself).",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Ticker (e.g. BONK), name, or mint address." },
          limit: { type: "number", description: "Max results. Default 10." },
        },
        required: ["query"],
      },
    },
    {
      name: "xpay_swap",
      description:
        "THE ONLY way to swap tokens — a single tool call that quotes, signs, and executes inside the " +
        "user's own xpay wallet via Jupiter (Solana only). NEVER write code or scripts (Python/JS/curl) " +
        "to swap, and never call Jupiter or DEX APIs directly: custom code bypasses the user's guardrail " +
        "caps and token-verification safety, and has no access to the wallet key anyway. When the user " +
        "actually wants to swap, this one tool call does everything (quote + sign + execute) — but " +
        "xpay_token_find alone answers informational questions; do NOT follow it with a swap unless the " +
        "user asked to trade. Swaps are irreversible and guardrail caps are enforced before signing. Before calling, show the " +
        "user: the input amount + USD value, the expected output amount, and the output token's mint + " +
        "verification status — and get their explicit approval. Never swap unprompted, and never swap " +
        "into an unverified token without the user confirming the exact mint. Ambiguous tickers return " +
        "an error listing candidate mints — pass the exact mint to disambiguate.",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount of the input token, human units (e.g. 0.5)." },
          from: { type: "string", description: "Input token: symbol (SOL, USDC, BONK, …) or mint address." },
          to: { type: "string", description: "Output token: symbol or mint address. Prefer the exact mint from xpay_token_find." },
          slippageBps: { type: "number", description: "Max slippage in bps (50 = 0.5%). Default: Jupiter dynamic slippage (recommended)." },
        },
        required: ["amount", "from", "to"],
      },
    },
    {
      name: "xpay_x_user",
      description:
        "Realtime X (Twitter) profile lookup — followers, bio, verification status. This is a PAID " +
        "call (~$0.01 USDC from the wallet via x402, at cost — no markup); guardrail caps apply. " +
        "Great for due diligence on a token's or project's X account before a swap. Don't spam it: " +
        "results barely change minute to minute, so one call per account per conversation is enough.",
      input_schema: {
        type: "object",
        properties: {
          handle: { type: "string", description: "X username, with or without the leading @." },
        },
        required: ["handle"],
      },
    },
    {
      name: "xpay_x_posts",
      description:
        "Recent posts from an X (Twitter) account (up to 10, excludes retweets/replies) with " +
        "engagement metrics. PAID call (~$0.06 USDC from the wallet via x402, at cost — no markup); " +
        "guardrail caps apply. Use for checking what a project/account is actually saying right now " +
        "(e.g. before swapping into their token). One call per account per conversation is enough.",
      input_schema: {
        type: "object",
        properties: {
          handle: { type: "string", description: "X username, with or without the leading @." },
          limit: { type: "number", description: "Posts to return, 1-10. Default 10." },
        },
        required: ["handle"],
      },
    },
    {
      name: "xpay_zauth_reposcan",
      description:
        "Repository security scan via zauth (partner) — scans a git repo for code provenance and " +
        "vulnerabilities. PAID call (~$0.05 USDC from the wallet via x402; guardrail caps apply). " +
        "Scans can take a while: if the response still says status \"scanning\", check later with " +
        "xpay_zauth_scan_status using the returned sessionToken (the long JWT string, NOT the short " +
        "scanId — the token is valid ~1 hour). Do NOT call this tool again for the same repo, that " +
        "pays for a second scan. Results are informational: report them to the user, never " +
        "auto-remediate or trigger further payments based on findings.",
      input_schema: {
        type: "object",
        properties: {
          repoUrl: { type: "string", description: "Repository URL to scan, e.g. https://github.com/owner/repo." },
        },
        required: ["repoUrl"],
      },
    },
    {
      name: "xpay_zauth_scan_status",
      description:
        "Check a running zauth repo scan by sessionToken (returned by xpay_zauth_reposcan). " +
        "FREE, read-only, no wallet — always use this to follow up on a pending scan instead of " +
        "re-calling xpay_zauth_reposcan, which would pay again. Pass the sessionToken (the long " +
        "JWT starting with \"eyJ\"), NOT the scanId — the scanId is rejected with a 401.",
      input_schema: {
        type: "object",
        properties: {
          sessionToken: {
            type: "string",
            description:
              "sessionToken from a pending xpay_zauth_reposcan result — the long JWT string " +
              "(starts with \"eyJ\"), not the scanId. Valid ~1 hour after the scan started.",
          },
        },
        required: ["sessionToken"],
      },
    },
    {
      name: "xpay_agenc_status",
      description:
        "Check the progress of an AgenC marketplace hire (read-only, no wallet). " +
        "Pass the task PDA from the hire receipt returned by xpay_use / xpay_do. " +
        "Status flow: open/claimed → review (provider submitted, awaiting buyer review) → settled. " +
        "The AgenC API snapshot rebuilds ~every 45s, so a just-created task may 404 briefly.",
      input_schema: {
        type: "object",
        properties: {
          taskPda: { type: "string", description: "Task PDA from the AgenC hire receipt." },
        },
        required: ["taskPda"],
      },
    },
  ];

  const handlers: ToolBundle<ClaudeToolDef>["handlers"] = {
    xpay_discover: async (input) => {
      const sources = input.sources as string[] | undefined;
      return xpay.discover({
        query: input.query as string | undefined,
        // Browsing a single catalog implies "show me what's there" — don't
        // truncate to the mixed-results default.
        limit: (input.limit as number) ?? (sources?.length === 1 ? 50 : 5),
        networks: input.network ? [input.network as string] : undefined,
        sources,
      });
    },

    xpay_use: async (input) => {
      // Prefer the full resource object from xpay_discover — it carries
      // pre-fetched accepts[] so we take the catalog path (no probe round-trip).
      if (input.resource && typeof input.resource === "object") {
        const parsed = ResourceSchema.safeParse(input.resource);
        if (parsed.success) {
          return xpay.use(parsed.data, { body: input.body as unknown });
        }
      }
      // Fallback: only a URL was provided — probe the resource for a 402 challenge.
      const url = input.resourceUrl as string;
      if (!url) throw new Error("xpay_use: provide either `resource` (full object from xpay_discover) or `resourceUrl`");
      return xpay.useByUrl(url, { body: input.body as unknown });
    },

    xpay_do: async (input) =>
      xpay.do(input.query as string, { body: input.body as unknown }),

    xpay_transfer: async (input) =>
      xpay.transfer({
        amount:  input.amount  as number,
        to:      input.to      as string,
        token:   (input.token as string | undefined) ?? "USDC",
        network: input.network as string | undefined,
        private: input.private as boolean | undefined,
      }),

    xpay_balance: async (input) => {
      const networks = input.network
        ? [input.network as string]
        : xpay.wallet.networks;

      const perNetwork: Record<string, unknown> = {};
      let stablecoinTotal = 0;

      for (const n of networks) {
        if (!xpay.wallet.has(n)) continue;
        const signer = xpay.wallet.signer(n);

        if (typeof signer.tokenBalances === "function") {
          // Full token breakdown — same path as the CLI. Solana balances are
          // enriched via Jupiter: unknown mints get real symbols/names, and
          // priceable tokens carry usdPrice/usdValue.
          const raw = await signer.tokenBalances().catch(() => []);
          const tokens = n === "solana" ? await enrichTokenBalances(raw) : raw;
          perNetwork[n] = {
            address: signer.address,
            tokens: tokens.map((t) => ({
              symbol: t.symbol,
              name: t.name,
              balance: t.balance,
              native: t.isNative ?? false,
              address: t.address,
              usdPrice: (t as { usdPrice?: number }).usdPrice,
              usdValue: (t as { usdValue?: number }).usdValue,
              verified: (t as { verified?: boolean }).verified,
            })),
          };
          for (const t of tokens) {
            if (t.symbol === "USDC" || t.symbol === "USDT") stablecoinTotal += t.balance;
          }
        } else {
          // Fallback: USDC only.
          const usdc = typeof signer.balance === "function"
            ? await signer.balance().catch(() => 0)
            : 0;
          perNetwork[n] = { address: signer.address, tokens: [{ symbol: "USDC", balance: usdc, native: false }] };
          stablecoinTotal += usdc;
        }
      }

      return { perNetwork, stablecoinTotal };
    },

    xpay_report: async (input) =>
      xpay.report({
        period: (input.period as "daily" | "weekly" | "monthly") ?? "weekly",
        network: input.network as string | undefined,
      }),

    xpay_guardrail: async () => xpay.guardrail,

    xpay_token_find: async (input) =>
      xpay.findTokens(input.query as string, {
        limit: (input.limit as number) ?? 10,
      }),

    xpay_swap: async (input) =>
      xpay.swap({
        amount: input.amount as number,
        from: input.from as string,
        to: input.to as string,
        slippageBps: input.slippageBps as number | undefined,
      }),

    xpay_x_user: async (input) =>
      xpay.useByUrl(`${XDATA_BASE}/x/user`, {
        method: "POST",
        body: { handle: input.handle as string },
      }),

    xpay_x_posts: async (input) =>
      xpay.useByUrl(`${XDATA_BASE}/x/posts`, {
        method: "POST",
        body: { handle: input.handle as string, limit: input.limit as number | undefined },
      }),

    xpay_zauth_reposcan: async (input) => {
      const result = await xpay.useByUrl(`${ZAUTH_BASE}/x402/reposcan`, {
        method: "POST",
        body: { repoUrl: input.repoUrl as string },
      });
      if (!isScanPending(result.data)) return { ...result, data: compactScanReport(result.data) };
      // Paid + scan kicked off — poll the free status endpoint for a while.
      // Poll responses don't echo the sessionToken, so keep the kickoff's
      // copy and re-attach it if the scan outlives our window.
      const sessionToken = result.data.sessionToken;
      const data = await pollRepoScan(sessionToken, { timeoutMs: 90_000 });
      if (isScanning(data)) {
        return {
          ...result,
          data: {
            ...(data as Record<string, unknown>),
            sessionToken,
            note:
              "Scan still running — check later with xpay_zauth_scan_status, passing this " +
              "sessionToken (the long JWT, NOT the scanId). Do not re-run xpay_zauth_reposcan " +
              "for this repo; that pays again.",
          },
        };
      }
      return { ...result, data: compactScanReport(data) };
    },

    xpay_zauth_scan_status: async (input) =>
      compactScanReport(await fetchScanStatus(input.sessionToken as string)),

    xpay_agenc_status: async (input) => fetchAgencTask(input.taskPda as string),
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
