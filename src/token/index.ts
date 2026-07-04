/**
 * Solana token discovery — Jupiter Token API v2.
 *
 * Keyless read-only search by ticker, name, or mint address. Returns live
 * market data (price, mcap, liquidity) plus Jupiter's verification flag —
 * the main scam signal agents must check before swapping (anyone can mint a
 * token reusing a real project's ticker).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { SOLANA_TOKENS } from "../transfer/index.js";

const DEFAULT_ENDPOINT = "https://api.jup.ag";

/** Wrapped-SOL mint — Jupiter's sentinel for native SOL (wraps/unwraps automatically). */
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Jupiter verification — unverified tokens can be scams reusing a real ticker. */
  verified: boolean;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  holderCount?: number;
  organicScore?: number;
  tokenProgram?: string;
  icon?: string;
}

export interface TokenApiOptions {
  /** Jupiter API base. Default https://api.jup.ag (env: XPAY_JUPITER_ENDPOINT). */
  endpoint?: string;
  /** Optional Jupiter API key for higher rate limits (env: JUPITER_API_KEY). */
  apiKey?: string;
}

/** Thrown when a bare ticker matches several plausible tokens — retry with the exact mint. */
export class AmbiguousTokenError extends Error {
  readonly candidates: TokenInfo[];
  constructor(input: string, candidates: TokenInfo[]) {
    const list = candidates
      .map((c) => `  ${c.symbol} (${c.name}) mint ${c.mint}${c.verified ? " [verified]" : " [UNVERIFIED]"} liquidity $${Math.round(c.liquidity ?? 0).toLocaleString()}`)
      .join("\n");
    super(
      `Token "${input}" is ambiguous — pass the exact mint address of the one you mean:\n${list}`,
    );
    this.name = "AmbiguousTokenError";
    this.candidates = candidates;
  }
}

/**
 * Search tokens by ticker, name, or mint. Ranked verified-first, then by
 * liquidity. Read-only — no wallet, no signing.
 */
export async function findTokens(
  query: string,
  opts: TokenApiOptions & { limit?: number } = {},
): Promise<TokenInfo[]> {
  const raw = await searchJupiter(query, opts);
  const limit = opts.limit ?? 10;

  const seen = new Set<string>();
  const ranked = raw
    .filter((t) => (seen.has(t.mint) ? false : (seen.add(t.mint), true)))
    .sort((a, b) => {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      const liq = (b.liquidity ?? 0) - (a.liquidity ?? 0);
      if (liq !== 0) return liq;
      return (b.organicScore ?? 0) - (a.organicScore ?? 0);
    });

  return ranked.slice(0, limit);
}

/**
 * Deterministic single-token resolution for trading. Accepts a symbol or a
 * mint address; never silently picks between plausible candidates — throws
 * {@link AmbiguousTokenError} instead so the caller can pass the exact mint.
 */
export async function resolveTradeToken(input: string, opts: TokenApiOptions = {}): Promise<TokenInfo> {
  const key = input.toUpperCase().replace(/[-\s]/g, "");

  // Native SOL / wSOL → Jupiter's wrapped-SOL sentinel, displayed as SOL.
  if (key === "SOL" || key === "WSOL") {
    const [info] = await searchJupiter(NATIVE_SOL_MINT, opts);
    return { ...(info ?? fallbackToken(NATIVE_SOL_MINT, 9)), symbol: "SOL", verified: true };
  }

  // Well-known symbols pin to a canonical mint (avoids the ~20 lookalike
  // "BONK"s Jupiter returns) — then still fetch live data by that mint.
  const pinned = SOLANA_TOKENS[key] ?? Object.values(SOLANA_TOKENS).find((t) => t.symbol.toUpperCase() === key);
  if (pinned) {
    const [info] = await searchJupiter(pinned.mint, opts);
    return info ?? { ...fallbackToken(pinned.mint, pinned.decimals), symbol: pinned.symbol, verified: true };
  }

  // Mint-shaped input → exact lookup; fall back to on-chain decimals for
  // tokens Jupiter has never indexed.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) {
    const matches = await searchJupiter(input, opts);
    const exact = matches.find((t) => t.mint === input);
    if (exact) return exact;
    return onChainToken(input);
  }

  // Unknown ticker → search; only exact-symbol, verified matches are eligible.
  const results = await searchJupiter(input, opts);
  const symbolMatches = results.filter((t) => t.symbol.toUpperCase() === key);
  const verified = symbolMatches.filter((t) => t.verified);

  if (verified.length === 1) return verified[0]!;
  if (verified.length > 1) {
    // Auto-pick only when the leader dwarfs the runner-up in liquidity.
    const sorted = [...verified].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    if ((sorted[0]!.liquidity ?? 0) >= 5 * (sorted[1]!.liquidity ?? 0) && (sorted[0]!.liquidity ?? 0) > 0) {
      return sorted[0]!;
    }
    throw new AmbiguousTokenError(input, sorted.slice(0, 5));
  }
  if (symbolMatches.length > 0) {
    // Only unverified candidates — never auto-trade those by ticker.
    throw new AmbiguousTokenError(
      input,
      symbolMatches.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0)).slice(0, 5),
    );
  }

  throw new Error(
    `Unknown token "${input}" — no exact ticker match on Jupiter. ` +
      `Try \`xpay token find ${input}\` to search, or pass the mint address directly.`,
  );
}

/** A wallet token balance enriched with live Jupiter market data. */
export interface EnrichedTokenBalance {
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  address?: string;
  isNative?: boolean;
  usdPrice?: number;
  usdValue?: number;
  verified?: boolean;
}

/**
 * Label and price wallet balances via one batched Jupiter lookup (comma-
 * separated mints, max 100). Unknown mints get their real symbol/name; every
 * priceable token gets `usdPrice`/`usdValue`. Never throws — on any Jupiter
 * failure the input balances are returned unchanged (a balance display must
 * not break because a market-data API hiccuped).
 */
export async function enrichTokenBalances(
  balances: Array<{ symbol: string; name: string; balance: number; decimals: number; address?: string; isNative?: boolean }>,
  opts: TokenApiOptions = {},
): Promise<EnrichedTokenBalance[]> {
  try {
    const mints = [...new Set(
      balances.map((b) => (b.isNative ? NATIVE_SOL_MINT : b.address)).filter((m): m is string => Boolean(m)),
    )].slice(0, 100);
    if (mints.length === 0) return balances;

    const infos = await findTokens(mints.join(","), { ...opts, limit: mints.length });
    const byMint = new Map(infos.map((t) => [t.mint, t]));

    return balances.map((b) => {
      const info = byMint.get(b.isNative ? NATIVE_SOL_MINT : (b.address ?? ""));
      if (!info) return b;
      const unknown = !b.name || b.name === "Unknown Token";
      return {
        ...b,
        symbol: b.isNative ? b.symbol : unknown ? info.symbol : b.symbol,
        name: b.isNative ? b.name : unknown ? info.name : b.name,
        usdPrice: info.usdPrice,
        usdValue: info.usdPrice !== undefined ? info.usdPrice * b.balance : undefined,
        verified: info.verified,
      };
    });
  } catch {
    return balances;
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

interface JupiterTokenItem {
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  isVerified?: boolean;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  holderCount?: number;
  organicScore?: number;
  tokenProgram?: string;
  icon?: string;
}

async function searchJupiter(query: string, opts: TokenApiOptions): Promise<TokenInfo[]> {
  const endpoint = opts.endpoint ?? process.env.XPAY_JUPITER_ENDPOINT ?? DEFAULT_ENDPOINT;
  const apiKey = opts.apiKey ?? process.env.JUPITER_API_KEY;

  const url = new URL("/tokens/v2/search", endpoint);
  url.searchParams.set("query", query);

  const body = (await jupiterFetch(url.toString(), apiKey)) as JupiterTokenItem[];
  if (!Array.isArray(body)) return [];

  return body
    .filter((t) => t && typeof t.id === "string")
    .map((t) => ({
      mint: t.id,
      symbol: t.symbol ?? t.id.slice(0, 6) + "…",
      name: t.name ?? "",
      decimals: t.decimals ?? 0,
      verified: t.isVerified ?? false,
      usdPrice: numOrUndef(t.usdPrice),
      mcap: numOrUndef(t.mcap),
      fdv: numOrUndef(t.fdv),
      liquidity: numOrUndef(t.liquidity),
      holderCount: numOrUndef(t.holderCount),
      organicScore: numOrUndef(t.organicScore),
      tokenProgram: t.tokenProgram,
      icon: t.icon,
    }));
}

/** GET with a 10s timeout and backoff retries on 429 (keyless bucket is small). */
export async function jupiterFetch(url: string, apiKey?: string, init?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  const MAX_RETRIES = 2;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1_500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      let reason = "";
      try {
        const body = (await res.json()) as { error?: string; errorMessage?: string };
        reason = body?.error ?? body?.errorMessage ?? "";
      } catch { /* no body */ }
      throw new Error(
        `Jupiter API ${res.status} ${res.statusText}${reason ? ` — ${reason}` : ""}` +
          (res.status === 429 ? " (rate-limited; set JUPITER_API_KEY for higher limits)" : ""),
      );
    }
    return res.json();
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function fallbackToken(mint: string, decimals: number): TokenInfo {
  return { mint, symbol: mint.slice(0, 6) + "…", name: "", decimals, verified: false };
}

/** Last resort for mints Jupiter has never indexed — decimals from chain, no price. */
async function onChainToken(mint: string): Promise<TokenInfo> {
  const rpc = process.env.XPAY_SOLANA_RPC ?? "https://solana-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ";
  try {
    const conn = new Connection(rpc, "confirmed");
    const info = await getMint(conn, new PublicKey(mint));
    return fallbackToken(mint, info.decimals);
  } catch {
    throw new Error(
      `Token mint ${mint} not found on Jupiter or on-chain — check the address.`,
    );
  }
}
