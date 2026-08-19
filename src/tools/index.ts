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
import { robinhoodHoldings } from "../trading/discovery.js";
import { forSana } from "../sana/tools.js";
import {
  ZAUTH_BASE,
  isScanPending,
  isScanning,
  pollRepoScan,
  fetchScanStatus,
  compactScanReport,
} from "../zauth/index.js";
import {
  SHOP_BASE,
  fetchShopQuote,
  fetchShopLensQuote,
  resolveLensImageUrl,
  compactShopResult,
  type ShopSearchParams,
  type ShopLensParams,
} from "../shop/index.js";
import { findRwaTokens, type RwaCategory } from "../token/rwa.js";
import { findMppServices, searchMppServices, mppServiceResources } from "../discover/mppscan.js";

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
  /** Sana API key - when present, registers sana_* tools alongside xpay_* tools. */
  sanaApiKey?: string;
}

/** MCP tool annotations (readOnly / openWorld / destructive hints). */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
}

/** Fetches or computes only - no payment, no signing, no state change. */
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
/** Spends from the wallet: settles an irreversible on-chain payment and/or calls an external system. */
const SPEND: ToolAnnotations = { readOnlyHint: false, openWorldHint: true, destructiveHint: true };
/** Writes local profile config only - reversible, nothing leaves the machine. */
const LOCAL_CONFIG: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };

/**
 * Annotations for every tool the MCP server exposes, keyed by tool name.
 * Kept out of the vendor tool defs (forClaude/forOpenAI/forGemini) because
 * provider APIs reject unknown fields; the MCP server merges these into its
 * ListTools response. Includes the three bento tools registered directly in
 * mcp-server.ts.
 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  xpay_discover: READ,
  xpay_use: SPEND,
  xpay_do: SPEND,
  xpay_transfer: SPEND,
  xpay_balance: READ,
  xpay_report: READ,
  xpay_guardrail: READ,
  xpay_token_find: READ,
  xpay_swap: SPEND,
  xpay_trending_tokens: READ,
  xpay_trade_quote: READ,
  xpay_trade: SPEND,
  xpay_x_user: SPEND,
  xpay_x_posts: SPEND,
  xpay_zauth_reposcan: SPEND,
  xpay_zauth_scan_status: READ,
  xpay_rwa_find: READ,
  xpay_mpp_find: READ,
  xpay_mpp_resources: READ,
  xpay_shop_quote: READ,
  xpay_shop_search: SPEND,
  xpay_shop_lens_quote: READ,
  xpay_shop_lens: SPEND,
  xpay_agenc_status: READ,
  xpay_bento_status: READ,
  xpay_bento_enable: LOCAL_CONFIG,
  xpay_bento_disable: LOCAL_CONFIG,
};

/** Anthropic Claude tool definitions. */
export function forClaude(xpay: XPay, opts: ToolOptions = {}): ToolBundle<ClaudeToolDef> {
  const tools: ClaudeToolDef[] = [
    {
      name: "xpay_discover",
      description:
        "Find paid HTTP services across the agentic-commerce catalog (PayAI + others). " +
        "Returns ranked candidates with price, network, and payment recipient. " +
        "Results may include AgenC marketplace agent listings (metadata.source === 'agenc') - " +
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
        "Prefer passing the full `resource` object returned by xpay_discover - it includes " +
        "pre-fetched payment requirements so payment goes through without a probe round-trip. " +
        "Fall back to `resourceUrl` only when you have a URL but no catalog entry. " +
        "If the resource is an AgenC marketplace listing it executes as a Solana escrow hire " +
        "instead: SOL is escrowed on-chain and the result is a hire receipt (task PDA + tx " +
        "signature), NOT an HTTP response - the provider works asynchronously; poll progress " +
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
        "EVM supports the network's stablecoin only: USDC, or USDT0 on Stable (network \"stable\", chain 988). " +
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
      description:
        "Token balances on each configured network, plus a stablecoin total. " +
        "Covers Solana, Base and the other EVM chains, Robinhood Chain, and Stable (USDT0).",
      input_schema: {
        type: "object",
        properties: {
          network: { type: "string", description: "Restrict to one network (solana, base, stable, robinhood, ...)." },
        },
      },
    },
    {
      name: "xpay_report",
      description:
        "Comprehensive USDC activity report for the wallet - totals, net flow, daily timeline, top counterparties, and biggest transactions. " +
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
        "Find Solana tokens by ticker, name, or mint address (Jupiter registry). Read-only - no " +
        "wallet, no spending. Returns mint, price, market cap, liquidity, and a `verified` flag. " +
        "ALWAYS check `verified` before suggesting a swap: unverified tokens can be scams reusing a " +
        "real token's ticker. This tool alone answers price/info questions - only proceed to a swap " +
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
        "THE ONLY way to swap tokens - a single tool call that quotes, signs, and executes inside the " +
        "user's own xpay wallet via Jupiter (Solana only). NEVER write code or scripts (Python/JS/curl) " +
        "to swap, and never call Jupiter or DEX APIs directly: custom code bypasses the user's guardrail " +
        "caps and token-verification safety, and has no access to the wallet key anyway. When the user " +
        "actually wants to swap, this one tool call does everything (quote + sign + execute) - but " +
        "xpay_token_find alone answers informational questions; do NOT follow it with a swap unless the " +
        "user asked to trade. Swaps are irreversible and guardrail caps are enforced before signing. Before calling, show the " +
        "user: the input amount + USD value, the expected output amount, and the output token's mint + " +
        "verification status - and get their explicit approval. Never swap unprompted, and never swap " +
        "into an unverified token without the user confirming the exact mint. Ambiguous tickers return " +
        "an error listing candidate mints - pass the exact mint to disambiguate.",
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
      name: "xpay_trending_tokens",
      description:
        "List tokens trending on Robinhood Chain (Robinhood's Arbitrum L2, home of the NOXA Fun / " +
        "fun.noxa.fi memecoin scene) right now, with price, market cap, 24h volume, and the token's " +
        "contract address. FREE, read-only, no wallet. Use this to answer 'what's hot on Robinhood " +
        "Chain' and to get the exact contract address to pass to xpay_trade. Pass newOnly:true for " +
        "the freshest launches (higher risk). This is Robinhood *Chain* on-chain data - unrelated to " +
        "the Robinhood brokerage app or stock trading.",
      input_schema: {
        type: "object",
        properties: {
          newOnly: { type: "boolean", description: "Show newest pools instead of trending. Default false." },
          limit: { type: "number", description: "Max results. Default 10." },
        },
      },
    },
    {
      name: "xpay_trade_quote",
      description:
        "Quote a Robinhood Chain trade WITHOUT executing - no signing, no funds moved, no guardrail. " +
        "Buy a token with native ETH or sell it back to ETH, routed through Uniswap V3 (NOXA Fun " +
        "pools). Returns expected output, min output after slippage, pool fee, USD estimate, and " +
        "whether the token is a verified NOXA launch. Use this to preview a trade before calling " +
        "xpay_trade. `from`/`to` are 'ETH' or an ERC-20 contract address (or a trending symbol); " +
        "exactly one side must be ETH.",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount of the input token, human units (e.g. 0.01)." },
          from: { type: "string", description: "Input: 'ETH' or an ERC-20 contract address / trending symbol." },
          to: { type: "string", description: "Output: 'ETH' or an ERC-20 contract address / trending symbol." },
          slippageBps: { type: "number", description: "Max slippage in bps (100 = 1%). Default 100." },
        },
        required: ["amount", "from", "to"],
      },
    },
    {
      name: "xpay_trade",
      description:
        "Trade tokens on Robinhood Chain (Arbitrum L2) via Uniswap V3 - quotes, signs, and executes " +
        "in ONE call from the user's own xpay wallet. Buy a memecoin with native ETH, or sell it back " +
        "to ETH (v1 supports ETH↔token only). This is distinct from xpay_swap, which is Solana/Jupiter. " +
        "NEVER write code or call DEX/router contracts yourself - custom code bypasses the guardrail and " +
        "has no wallet key. Trades are IRREVERSIBLE; guardrail caps are enforced before signing. Before " +
        "calling: show the user the input amount + USD value, expected output, the token's contract " +
        "address, and whether it's a verified NOXA launch (unverified tokens can be scams reusing a " +
        "ticker) - and get explicit approval. Prefer passing the exact contract address from " +
        "xpay_trending_tokens over a symbol (memecoin tickers aren't unique). Fund the wallet with ETH " +
        "on Robinhood Chain first (bridge via Across or Uniswap) - the wallet pays its own gas here.",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount of the input token, human units (e.g. 0.01)." },
          from: { type: "string", description: "Input: 'ETH' or an ERC-20 contract address / trending symbol." },
          to: { type: "string", description: "Output: 'ETH' or an ERC-20 contract address / trending symbol." },
          slippageBps: { type: "number", description: "Max slippage in bps (100 = 1%). Default 100." },
        },
        required: ["amount", "from", "to"],
      },
    },
    {
      name: "xpay_x_user",
      description:
        "Realtime X (Twitter) profile lookup - followers, bio, verification status. This is a PAID " +
        "call (~$0.01 USDC from the wallet via x402, at cost - no markup); guardrail caps apply. " +
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
        "engagement metrics. PAID call (~$0.06 USDC from the wallet via x402, at cost - no markup); " +
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
        "Repository security scan via zauth (partner) - scans a git repo for code provenance and " +
        "vulnerabilities. PAID call (~$0.05 USDC from the wallet via x402; guardrail caps apply). " +
        "Scans can take a while: if the response still says status \"scanning\", check later with " +
        "xpay_zauth_scan_status using the returned sessionToken (the long JWT string, NOT the short " +
        "scanId - the token is valid ~1 hour). Do NOT call this tool again for the same repo, that " +
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
        "FREE, read-only, no wallet - always use this to follow up on a pending scan instead of " +
        "re-calling xpay_zauth_reposcan, which would pay again. Pass the sessionToken (the long " +
        "JWT starting with \"eyJ\"), NOT the scanId - the scanId is rejected with a 401.",
      input_schema: {
        type: "object",
        properties: {
          sessionToken: {
            type: "string",
            description:
              "sessionToken from a pending xpay_zauth_reposcan result - the long JWT string " +
              "(starts with \"eyJ\"), not the scanId. Valid ~1 hour after the scan started.",
          },
        },
        required: ["sessionToken"],
      },
    },
    {
      name: "xpay_rwa_find",
      description:
        "List tradable RWA (real-world asset) tokens on Solana: FREE, read-only, no wallet. " +
        "RWA means any tokenized off-chain asset, not just stocks. What is tradable on Solana " +
        "DEXes today: tokenized stocks/ETFs (Backed xStocks like TSLAx/SPYx, Ondo Global Markets " +
        "like TSLAon/GLDon, Remora, Backpack) plus the treasury-backed yieldcoin USDY. Ranked " +
        "verified-first by liquidity, with live price/mcap from Jupiter. Results are swappable " +
        "from USDC via xpay_swap (confirm with the user first). Caveats to relay when relevant: " +
        "these are issuer IOUs tracking the underlying, not brokerage shares; permissioned funds " +
        "(BUIDL, OUSG) are excluded because they are KYC-gated and not DEX-tradable.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Substring filter on symbol/name, e.g. 'tesla' matches TSLAx and TSLAon. Omit to list all.",
          },
          category: {
            type: "string",
            enum: ["stocks", "treasuries"],
            description: "Restrict to tokenized stocks/ETFs or treasury-backed tokens. Default: both.",
          },
          limit: { type: "number", description: "Max results. Default 20." },
        },
      },
    },
    {
      name: "xpay_mpp_find",
      description:
        "Discover MPP (Machine Payments Protocol, the Stripe+Tempo HTTP 402 standard) and x402 " +
        "services from the MPPScan registry (mppscan.com, 350+ live services). FREE: gated by a " +
        "SIWX wallet sign-in (an EIP-191 identity signature), nothing is paid. With `query`, runs " +
        "semantic search and returns matching service origins with the protocols each speaks; " +
        "without, lists the registry's top services by transaction volume. Drill into one " +
        "service's callable endpoints with xpay_mpp_resources; pay any discovered endpoint with " +
        "xpay_use, which settles MPP or x402 automatically.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural-language task description for semantic search, e.g. 'image generation' or " +
              "'web search'. Omit to list the top registry services by usage.",
          },
          protocol: {
            type: "string",
            enum: ["mpp", "x402"],
            description: "Restrict semantic search to one protocol. Default mpp.",
          },
          limit: { type: "number", description: "Max results for the registry listing. Default 10." },
        },
      },
    },
    {
      name: "xpay_mpp_resources",
      description:
        "List the callable paid endpoints registered under one MPP service from the MPPScan " +
        "registry: URL, method, price, network. FREE (SIWX wallet sign-in, no payment). Pass a " +
        "service id from xpay_mpp_find or a domain/origin like 'glim.sh'. Returned URLs are " +
        "payable via xpay_use.",
      input_schema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description: "Registry service id (64-char hex) or domain/origin, e.g. 'stablestudio.dev'.",
          },
        },
        required: ["service"],
      },
    },
    {
      name: "xpay_shop_quote",
      description:
        "FREE preflight for product search via xona shop (partner): parses the query server-side " +
        "and reports the exact price a paid search would cost, which marketplaces it would hit " +
        "(google_shopping, amazon, ebay), and whether the query even looks like a product search. " +
        "No wallet needed. ALWAYS call this before xpay_shop_search when the query is ambiguous: " +
        "if is_product_query is false, the paid search would charge and return zero results.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text shopper query, e.g. 'used thinkpad x1 under $600'." },
          marketplaces: {
            type: "array",
            items: { type: "string", enum: ["google_shopping", "amazon", "ebay"] },
            description: "Restrict to specific marketplaces. Fewer marketplaces means a lower price.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "xpay_shop_search",
      description:
        "Product discovery via xona shop (partner): one free-text query fans out to Google Shopping, " +
        "Amazon, and eBay, results come back normalized, deduped, and ranked in a single schema. " +
        "PAID call (~$0.02 USDC for all three marketplaces, less for fewer; price scales with " +
        "marketplaces searched; paid from the wallet via x402, guardrail caps apply). The query " +
        "parser picks up price ranges, condition, and sort from natural language ('used dslr under " +
        "$300 cheapest first'), explicit fields override it. Use xpay_shop_quote first when unsure " +
        "the query is a product search. Results are informational: report them to the user, never " +
        "auto-buy or trigger further payments based on findings.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text shopper query. Only required field." },
          marketplaces: {
            type: "array",
            items: { type: "string", enum: ["google_shopping", "amazon", "ebay"] },
            description: "Restrict the search. Fewer marketplaces means a lower price.",
          },
          price_min: { type: "number", description: "Min price in USD." },
          price_max: { type: "number", description: "Max price in USD." },
          condition: {
            type: "string",
            enum: ["new", "open_box", "refurbished", "used", "for_parts"],
            description: "Item condition filter.",
          },
          sort: {
            type: "string",
            enum: ["relevance", "price_asc", "price_desc", "rating", "reviews", "discount", "newest"],
            description: "Result ordering. Default relevance.",
          },
          limit: { type: "number", description: "Max results after merge. Default 20." },
        },
        required: ["query"],
      },
    },
    {
      name: "xpay_shop_lens_quote",
      description:
        "FREE preflight for image-based product search via xona shop (partner): validates that the " +
        "image URL is a publicly reachable http(s) URL (the dominant failure mode) and reports the " +
        "exact price the paid lens call would cost for the chosen mode. No wallet needed. ALWAYS " +
        "call this before xpay_shop_lens: the paid call charges even when the image URL turns out " +
        "to be unreachable.",
      input_schema: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "Publicly reachable http(s) image URL. Data URIs and uploads are not supported.",
          },
          mode: {
            type: "string",
            enum: ["identify", "shop"],
            description: "Mode to price: identify (default, cheaper) or shop (adds the marketplace comparison).",
          },
          marketplaces: {
            type: "array",
            items: { type: "string", enum: ["google_shopping", "amazon", "ebay"] },
            description: "mode=shop only: restrict the comparison. Fewer marketplaces means a lower price.",
          },
        },
        required: ["image_url"],
      },
    },
    {
      name: "xpay_shop_lens",
      description:
        "Product discovery from an IMAGE via xona shop (partner): Google Lens identifies the " +
        "product and the retailers selling it, normalized into the same schema as " +
        "xpay_shop_search. Give the image as exactly ONE of: image_url (publicly reachable), " +
        "image_path (local file), or image_base64. Local files and base64 are first uploaded " +
        "(free) to xona's public image host, since Lens only accepts public URLs; the hosted URL " +
        "is echoed back as image_url for reuse. mode=identify (default, ~$0.02 USDC) answers " +
        "'what is this and who sells it' and derives a product name; mode=shop (~$0.04 for all " +
        "three marketplaces) additionally runs that name through Google Shopping, Amazon, and " +
        "eBay for a price comparison. PAID call (from the wallet via x402, guardrail caps apply). " +
        "When passing image_url, use xpay_shop_lens_quote first to check it is usable (uploads " +
        "need no preflight: the hosted URL is always reachable). If the response says the image " +
        "is not a product photo, do not retry with mode=shop. Results are informational: report " +
        "them to the user, never auto-buy or trigger further payments based on findings.",
      input_schema: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "Publicly reachable http(s) image URL of the product.",
          },
          image_path: {
            type: "string",
            description: "Local image file path (JPEG/PNG/GIF/WebP); uploaded to a public host before the lens call.",
          },
          image_base64: {
            type: "string",
            description: "Base64 image bytes (raw or data URI); uploaded to a public host before the lens call.",
          },
          mode: {
            type: "string",
            enum: ["identify", "shop"],
            description: "identify (default): matches + derived name. shop: adds the marketplace price comparison.",
          },
          q: {
            type: "string",
            description: "Optional text refinement applied alongside the image, e.g. 'in black' or 'size 10'.",
          },
          price_min: { type: "number", description: "Min price in USD." },
          price_max: { type: "number", description: "Max price in USD." },
          condition: {
            type: "string",
            enum: ["new", "open_box", "refurbished", "used", "for_parts"],
            description: "Item condition filter.",
          },
          sort: {
            type: "string",
            enum: ["relevance", "price_asc", "price_desc", "rating", "reviews", "discount", "newest"],
            description: "Result ordering. Default relevance.",
          },
          limit: { type: "number", description: "Max results. Default 20." },
          marketplaces: {
            type: "array",
            items: { type: "string", enum: ["google_shopping", "amazon", "ebay"] },
            description: "mode=shop only: restrict the comparison. Fewer marketplaces means a lower price.",
          },
        },
        // No required list: exactly one of image_url / image_path / image_base64,
        // enforced by the handler (JSON Schema oneOf is unreliable across hosts).
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
        // Browsing a single catalog implies "show me what's there" - don't
        // truncate to the mixed-results default.
        limit: (input.limit as number) ?? (sources?.length === 1 ? 50 : 5),
        networks: input.network ? [input.network as string] : undefined,
        sources,
      });
    },

    xpay_use: async (input) => {
      // Prefer the full resource object from xpay_discover - it carries
      // pre-fetched accepts[] so we take the catalog path (no probe round-trip).
      if (input.resource && typeof input.resource === "object") {
        const parsed = ResourceSchema.safeParse(input.resource);
        if (parsed.success) {
          return xpay.use(parsed.data, { body: input.body as unknown });
        }
      }
      // Fallback: only a URL was provided - probe the resource for a 402 challenge.
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
        // Left undefined, transfer() picks the network's stablecoin: USDC on
        // most EVM chains, USDT0 on Stable, USDC on Solana.
        token:   input.token as string | undefined,
        network: input.network as string | undefined,
        private: input.private as boolean | undefined,
      }),

    xpay_balance: async (input) => {
      // Robinhood Chain and Stable always have a signer (see
      // signersFromProfile) even when they're not in the profile's `networks`,
      // so include them in the default view.
      const configured = xpay.wallet.networks;
      const networks = input.network
        ? [input.network as string]
        : [...configured, ...["robinhood", "stable"].filter((n) => !configured.includes(n))];

      const perNetwork: Record<string, unknown> = {};
      let stablecoinTotal = 0;

      for (const n of networks) {
        if (!xpay.wallet.has(n)) continue;
        const signer = xpay.wallet.signer(n);

        if (typeof signer.tokenBalances === "function") {
          // Full token breakdown - same path as the CLI. Solana balances are
          // enriched via Jupiter: unknown mints get real symbols/names, and
          // priceable tokens carry usdPrice/usdValue.
          const raw = await signer.tokenBalances().catch(() => []);
          let tokens = n === "solana" ? await enrichTokenBalances(raw) : raw;
          // Robinhood Chain: the signer only knows a hardcoded token list, so
          // pull the wallet's full ERC-20 holdings from the chain explorer -
          // this is how memecoins bought via xpay_trade show up. Native ETH
          // still comes from the signer.
          if (n === "robinhood") {
            const native = (raw as Array<{ isNative?: boolean }>).filter((t) => t.isNative);
            const holdings = await robinhoodHoldings(signer.address);
            tokens = [...native, ...holdings] as typeof tokens;
          }
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
            // USDT0 is Stable's USDT (an ERC-20 OFT); its native gas coin
            // reports as USDT. Both are dollars, so both count.
            if (t.symbol === "USDC" || t.symbol === "USDT" || t.symbol === "USDT0") {
              stablecoinTotal += t.balance;
            }
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

    xpay_trending_tokens: async (input) => {
      const opts = { limit: (input.limit as number) ?? 10 };
      return input.newOnly ? xpay.newTokens(opts) : xpay.trendingTokens(opts);
    },

    xpay_trade_quote: async (input) =>
      xpay.tradeQuote({
        amount: input.amount as number,
        from: input.from as string,
        to: input.to as string,
        slippageBps: input.slippageBps as number | undefined,
      }),

    xpay_trade: async (input) =>
      xpay.trade({
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
      // Paid + scan kicked off - poll the free status endpoint for a while.
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
              "Scan still running - check later with xpay_zauth_scan_status, passing this " +
              "sessionToken (the long JWT, NOT the scanId). Do not re-run xpay_zauth_reposcan " +
              "for this repo; that pays again.",
          },
        };
      }
      return { ...result, data: compactScanReport(data) };
    },

    xpay_zauth_scan_status: async (input) =>
      compactScanReport(await fetchScanStatus(input.sessionToken as string)),

    xpay_rwa_find: async (input) =>
      findRwaTokens({
        query: input.query as string | undefined,
        category: input.category as RwaCategory | undefined,
        limit: (input.limit as number) ?? 20,
      }),

    xpay_mpp_find: async (input) => {
      if (input.query) {
        return searchMppServices({
          wallet: xpay.wallet,
          query: input.query as string,
          protocol: input.protocol as "mpp" | "x402" | undefined,
        });
      }
      return findMppServices({
        wallet: xpay.wallet,
        limit: (input.limit as number) ?? 10,
      });
    },

    xpay_mpp_resources: async (input) =>
      mppServiceResources({
        wallet: xpay.wallet,
        service: input.service as string,
      }),

    xpay_shop_quote: async (input) =>
      fetchShopQuote({
        query: input.query as string,
        marketplaces: input.marketplaces as string[] | undefined,
      }),

    xpay_shop_search: async (input) => {
      const params: ShopSearchParams = {
        query: input.query as string,
        marketplaces: input.marketplaces as string[] | undefined,
        price_min: input.price_min as number | undefined,
        price_max: input.price_max as number | undefined,
        condition: input.condition as string | undefined,
        sort: input.sort as string | undefined,
        limit: input.limit as number | undefined,
      };
      const result = await xpay.useByUrl(`${SHOP_BASE}/shop/search`, {
        method: "POST",
        body: params,
      });
      return { ...result, data: compactShopResult(result.data) };
    },

    xpay_shop_lens_quote: async (input) =>
      fetchShopLensQuote({
        image_url: input.image_url as string,
        mode: input.mode as string | undefined,
        marketplaces: input.marketplaces as string[] | undefined,
      }),

    xpay_shop_lens: async (input) => {
      // Local file / base64 inputs are bridged through xona's free public
      // image host: the lens door only accepts a public URL (SerpAPI fetches
      // the image itself). The upload happens before any payment.
      const { image_url, uploaded } = await resolveLensImageUrl({
        image_url: input.image_url as string | undefined,
        image_path: input.image_path as string | undefined,
        image_base64: input.image_base64 as string | undefined,
      });
      const params: ShopLensParams = {
        image_url,
        mode: input.mode as string | undefined,
        q: input.q as string | undefined,
        price_min: input.price_min as number | undefined,
        price_max: input.price_max as number | undefined,
        condition: input.condition as string | undefined,
        sort: input.sort as string | undefined,
        limit: input.limit as number | undefined,
        marketplaces: input.marketplaces as string[] | undefined,
      };
      const result = await xpay.useByUrl(`${SHOP_BASE}/shop/lens`, {
        method: "POST",
        body: params,
      });
      // Surface the hosted URL when we uploaded, so the agent can reuse it
      // (e.g. a mode=shop follow-up) without paying the upload time again.
      return {
        ...result,
        ...(uploaded ? { hosted_image_url: image_url } : {}),
        data: compactShopResult(result.data),
      };
    },

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
