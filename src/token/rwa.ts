/**
 * RWA (real-world asset) discovery on Solana - Jupiter Token API v2.
 *
 * "RWA" covers every tokenized off-chain asset: equities, ETFs, treasuries,
 * commodities, private credit. What is actually TRADABLE on Solana DEXes
 * today is narrower, and that is what this module surfaces:
 *
 *   - Tokenized stocks/ETFs: Backed xStocks (TSLAx, SPYx, ...), Ondo Global
 *     Markets (TSLAon, GLDon, ...), Remora, Backpack Securities. Jupiter tags
 *     these `rwa` / `stocks` / `xstocks` on each token record.
 *   - Treasury-backed yieldcoins: Ondo USDY (tagged `yield`/`yb`, not `rwa`,
 *     so it is pinned here explicitly).
 *
 * Permissioned funds (BlackRock BUIDL, Ondo OUSG) exist on Solana but are
 * KYC-gated: unverified on Jupiter, zero DEX liquidity, not swappable - they
 * are deliberately excluded.
 *
 * Jupiter's tag ENDPOINT rejects `rwa`/`stocks`/`xstocks` as queries (only
 * lst/verified work), so discovery sweeps the search endpoint with a few
 * curated queries and filters by each token's `tags` array instead. Free,
 * read-only, no wallet.
 */

import { searchTokens, type TokenInfo, type TokenApiOptions } from "./index.js";

/**
 * Search queries that together surface every rwa-tagged token family on
 * Jupiter. "Ondo Tokenized" is deliberately specific: the generic "tokenized"
 * ranking is volume-based and lets low-liquidity Ondo listings fall out of
 * its top-100 between runs.
 */
const SWEEP_QUERIES = ["xstock", "Ondo Tokenized", "tokenized", "treasury", "remora"];

/** Ondo USDY - treasury-backed yieldcoin, tagged yield/yb on Jupiter rather than rwa. */
const USDY_MINT = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6";

const CACHE_TTL_MS = 5 * 60_000;

export type RwaCategory = "stocks" | "treasuries";

export interface RwaToken extends TokenInfo {
  category: RwaCategory;
  /** Issuing platform, derived from Jupiter tags/naming. */
  issuer: string;
}

export interface RwaFindOptions extends TokenApiOptions {
  /** Substring filter on symbol/name, e.g. "tesla" matches TSLAx and TSLAon. */
  query?: string;
  /** Restrict to one category. Default: both. */
  category?: RwaCategory;
  /** Max results. Default 20. */
  limit?: number;
  /** Include unverified tokens (excluded by default - same scam caveat as any ticker). */
  includeUnverified?: boolean;
}

let sweepCache: { at: number; tokens: RwaToken[] } | undefined;

/**
 * List tradable RWA tokens on Solana, ranked by liquidity. The underlying
 * sweep (5 Jupiter calls) is cached in-process for 5 minutes; query/category
 * filtering is applied per call on the cached set.
 */
export async function findRwaTokens(opts: RwaFindOptions = {}): Promise<RwaToken[]> {
  const all = await sweep(opts);

  const q = opts.query?.trim().toLowerCase();
  const limit = opts.limit ?? 20;

  return all
    .filter((t) => (opts.category ? t.category === opts.category : true))
    .filter((t) => (opts.includeUnverified ? true : t.verified))
    .filter((t) =>
      q ? t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) : true,
    )
    .slice(0, limit);
}

async function sweep(opts: TokenApiOptions): Promise<RwaToken[]> {
  if (sweepCache && Date.now() - sweepCache.at < CACHE_TTL_MS) return sweepCache.tokens;

  const byMint = new Map<string, RwaToken>();

  // Sequential on purpose: the keyless Jupiter bucket is small and
  // jupiterFetch's 429 backoff works better without parallel bursts.
  for (const query of SWEEP_QUERIES) {
    let batch: TokenInfo[] = [];
    try {
      batch = await searchTokens(query, { ...opts, limit: 100 });
    } catch {
      // One failed sweep query degrades coverage, not the whole listing.
      continue;
    }
    for (const t of batch) {
      const tags = t.tags ?? [];
      if (!tags.includes("rwa") && !tags.includes("stocks")) continue;
      byMint.set(t.mint, { ...t, category: "stocks", issuer: issuerOf(t) });
    }
  }

  try {
    const [usdy] = await searchTokens(USDY_MINT, opts);
    if (usdy && usdy.mint === USDY_MINT) {
      byMint.set(usdy.mint, { ...usdy, category: "treasuries", issuer: "Ondo" });
    }
  } catch {
    /* listing survives without USDY */
  }

  const tokens = [...byMint.values()].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return (b.liquidity ?? 0) - (a.liquidity ?? 0);
  });

  if (tokens.length > 0) sweepCache = { at: Date.now(), tokens };
  return tokens;
}

function issuerOf(t: TokenInfo): string {
  if (t.tags?.includes("xstocks") || / xStock$/.test(t.name)) return "Backed xStocks";
  if (t.name.includes("(Ondo Tokenized)")) return "Ondo Global Markets";
  if (/remora/i.test(t.name)) return "Remora";
  if (/backpack/i.test(t.name)) return "Backpack Securities";
  return "other";
}
