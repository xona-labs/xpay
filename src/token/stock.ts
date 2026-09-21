/**
 * Tokenized stock quotes on Solana - Jupiter Price API v3.
 *
 * Builds on the RWA sweep (token/rwa.ts) for the universe of tradable
 * tokenized stocks/ETFs (Backed xStocks, Ondo Global Markets, Remora,
 * Backpack Securities), then enriches each with the stock-specific data
 * Jupiter bundles in Price v3 for these mints:
 *
 *   - on-chain price vs the underlying reference share price
 *   - premium/discount % (the on-chain token can trade rich or cheap,
 *     especially while the underlying market is closed)
 *   - 24h on-chain price change and DEX liquidity
 *
 * Free, read-only, no wallet. Price v3 lives on a different host than the
 * Token API: lite-api.jup.ag keyless, api.jup.ag with an API key.
 */

import { findRwaTokens, type RwaToken } from "./rwa.js";
import { jupiterFetch, type TokenApiOptions } from "./index.js";

/** Keyless Price v3 host. With JUPITER_API_KEY the api.jup.ag mirror is used. */
const LITE_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const KEYED_PRICE_URL = "https://api.jup.ag/price/v3";

/** Price v3 accepts comma-separated ids; stay under the documented cap. */
const PRICE_BATCH_SIZE = 50;

export type UsMarketStatus = "open" | "closed" | "pre_market" | "after_hours";

export interface StockQuote {
  mint: string;
  symbol: string;
  name: string;
  /** Issuing platform (Backed xStocks, Ondo Global Markets, ...). */
  issuer: string;
  verified: boolean;
  /** Live DEX price of the tokenized stock, USD. */
  onchainPrice?: number;
  /** Reference price of the underlying share, USD (bundled by Jupiter). */
  underlyingPrice?: number;
  /** (onchain - underlying) / underlying, in percent. Positive = premium. */
  premiumDiscountPct?: number;
  /** 24h on-chain price change, percent. */
  priceChange24hPct?: number;
  /** On-chain DEX liquidity, USD. Thin liquidity makes any premium untradable. */
  liquidityUsd?: number;
  /** Market cap of the underlying company/fund, USD. */
  underlyingMcapUsd?: number;
  /** Scaled-UI multiplier (stock splits are applied via this, not rebases). */
  uiMultiplier?: number;
  /** When Jupiter last refreshed the underlying reference price. */
  referenceUpdatedAt?: string;
}

export interface StockFindOptions extends TokenApiOptions {
  /** Substring filter on symbol/name: "AAPL" and "tesla" both work. */
  query?: string;
  /** Max results. Default 20. */
  limit?: number;
}

export interface StockFindResult {
  /** US equity market session right now (weekends yes, holidays not modeled). */
  marketStatus: UsMarketStatus;
  stocks: StockQuote[];
  /** Set when live quote enrichment failed and only static listings are returned. */
  note?: string;
}

/**
 * List tokenized stocks on Solana with live on-chain vs underlying pricing,
 * ranked by liquidity. The universe comes from the cached RWA sweep; quotes
 * are one batched Price v3 call per 50 mints. Quote enrichment degrades
 * gracefully: a Price v3 failure returns the listing without live fields.
 */
export async function findStocks(opts: StockFindOptions = {}): Promise<StockFindResult> {
  const tokens = await findRwaTokens({
    ...opts,
    query: opts.query,
    category: "stocks",
    limit: opts.limit ?? 20,
  });

  const marketStatus = usEquityMarketStatus();
  if (tokens.length === 0) return { marketStatus, stocks: [] };

  let priced: Map<string, JupiterPriceEntry>;
  try {
    priced = await fetchPrices(tokens.map((t) => t.mint), opts);
  } catch (err) {
    return {
      marketStatus,
      stocks: tokens.map((t) => baseQuote(t)),
      note: `Live quote lookup failed (${(err as Error).message}) - listing without premium/discount data.`,
    };
  }

  return {
    marketStatus,
    stocks: tokens.map((t) => enrich(baseQuote(t), priced.get(t.mint))),
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

interface JupiterPriceEntry {
  usdPrice?: number;
  priceChange24h?: number;
  liquidity?: number;
  stockData?: { price?: number; mcap?: number; updatedAt?: string };
  scaledUiConfig?: { multiplier?: number };
}

function baseQuote(t: RwaToken): StockQuote {
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    issuer: t.issuer,
    verified: t.verified,
    onchainPrice: t.usdPrice,
    liquidityUsd: t.liquidity,
  };
}

function enrich(q: StockQuote, entry: JupiterPriceEntry | undefined): StockQuote {
  if (!entry || typeof entry.usdPrice !== "number") return q;

  const onchain = entry.usdPrice;
  const underlying = typeof entry.stockData?.price === "number" ? entry.stockData.price : undefined;
  const premiumPct =
    underlying !== undefined && underlying > 0
      ? Math.round(((onchain - underlying) / underlying) * 10_000) / 100
      : undefined;

  return {
    ...q,
    onchainPrice: round2(onchain),
    underlyingPrice: underlying !== undefined ? round2(underlying) : undefined,
    premiumDiscountPct: premiumPct,
    priceChange24hPct: typeof entry.priceChange24h === "number" ? round2(entry.priceChange24h) : undefined,
    liquidityUsd: typeof entry.liquidity === "number" ? Math.round(entry.liquidity) : q.liquidityUsd,
    underlyingMcapUsd: typeof entry.stockData?.mcap === "number" ? Math.round(entry.stockData.mcap) : undefined,
    uiMultiplier: typeof entry.scaledUiConfig?.multiplier === "number" ? entry.scaledUiConfig.multiplier : undefined,
    referenceUpdatedAt: entry.stockData?.updatedAt,
  };
}

/** Batched Price v3 lookup. Returns whatever Jupiter priced; missing mints are simply absent. */
async function fetchPrices(mints: string[], opts: TokenApiOptions): Promise<Map<string, JupiterPriceEntry>> {
  const apiKey = opts.apiKey ?? process.env.JUPITER_API_KEY;
  const base = process.env.XPAY_JUPITER_PRICE_URL ?? (apiKey ? KEYED_PRICE_URL : LITE_PRICE_URL);

  const out = new Map<string, JupiterPriceEntry>();
  for (let i = 0; i < mints.length; i += PRICE_BATCH_SIZE) {
    const batch = mints.slice(i, i + PRICE_BATCH_SIZE);
    const url = new URL(base);
    url.searchParams.set("ids", batch.join(","));
    const body = (await jupiterFetch(url.toString(), apiKey)) as Record<string, JupiterPriceEntry>;
    if (body && typeof body === "object") {
      for (const [mint, entry] of Object.entries(body)) out.set(mint, entry);
    }
  }
  return out;
}

/**
 * US equity market session in America/New_York, DST handled by Intl.
 * Weekends are closed; exchange holidays are NOT modeled, so treat "open"
 * as best-effort. Premium/discount risk is highest outside regular hours.
 */
export function usEquityMarketStatus(now = new Date()): UsMarketStatus {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return "closed";

  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "open";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre_market";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after_hours";
  return "closed";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
