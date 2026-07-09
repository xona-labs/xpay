/**
 * Robinhood Chain token discovery — GeckoTerminal public API.
 *
 * GeckoTerminal indexes Robinhood Chain under the network id "robinhood"
 * (keyless, ~30 req/min). Used for the trending/new token tools and for the
 * USD pricing attached to trade quotes. Discovery is read-only market data —
 * the trade path itself never depends on it.
 */

const DEFAULT_ENDPOINT = "https://api.geckoterminal.com/api/v2";
const GT_NETWORK = "robinhood";
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

export interface DiscoveredToken {
  symbol: string;
  name: string;
  /** ERC-20 contract address on Robinhood Chain. */
  address: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volume24hUsd?: number;
  priceChange24hPct?: number;
  /** Liquidity pool: 20-byte address (Uniswap v3) or 32-byte id (v4). */
  pool: string;
  /** True for v4 pool ids — xpay_trade only routes v3 pools today. */
  poolIsV4: boolean;
  dex?: string;
  poolCreatedAt?: string;
}

function endpoint(): string {
  return process.env.XPAY_GECKOTERMINAL_ENDPOINT ?? DEFAULT_ENDPOINT;
}

async function gtFetch(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${endpoint()}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GeckoTerminal ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return (await res.json()) as Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Map a GeckoTerminal pools payload to per-token entries. */
function poolsToTokens(payload: Record<string, unknown>, limit: number): DiscoveredToken[] {
  const data = (payload.data ?? []) as Array<Record<string, any>>;
  const out: DiscoveredToken[] = [];
  for (const pool of data) {
    const attrs = pool.attributes ?? {};
    // base_token id looks like "robinhood_0x020b…" — address after the prefix.
    const baseId: string = pool.relationships?.base_token?.data?.id ?? "";
    const address = baseId.includes("_") ? baseId.slice(baseId.indexOf("_") + 1) : "";
    if (!address.startsWith("0x")) continue;
    // Pool name looks like "CASHCAT / WETH 1%".
    const name: string = attrs.name ?? "";
    const symbol = name.split("/")[0]?.trim() ?? "";
    const poolAddress: string = attrs.address ?? "";
    out.push({
      symbol,
      name,
      address,
      priceUsd: num(attrs.base_token_price_usd),
      marketCapUsd: num(attrs.market_cap_usd) ?? undefined,
      fdvUsd: num(attrs.fdv_usd),
      volume24hUsd: num(attrs.volume_usd?.h24),
      priceChange24hPct: num(attrs.price_change_percentage?.h24),
      pool: poolAddress,
      poolIsV4: poolAddress.length > 42,
      dex: pool.relationships?.dex?.data?.id,
      poolCreatedAt: attrs.pool_created_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Tokens from pools trending on Robinhood Chain right now. */
export async function trendingTokens(opts: { limit?: number } = {}): Promise<DiscoveredToken[]> {
  const payload = await gtFetch(`/networks/${GT_NETWORK}/trending_pools?page=1`);
  return poolsToTokens(payload, opts.limit ?? 10);
}

/** Tokens from the most recently created pools (fresh launches — high risk). */
export async function newTokens(opts: { limit?: number } = {}): Promise<DiscoveredToken[]> {
  const payload = await gtFetch(`/networks/${GT_NETWORK}/new_pools?page=1`);
  return poolsToTokens(payload, opts.limit ?? 10);
}

/** Spot USD price for a token (e.g. WETH → effective ETH price). Best-effort. */
export async function tokenPriceUsd(address: string): Promise<number | undefined> {
  try {
    const payload = await gtFetch(`/networks/${GT_NETWORK}/tokens/${address.toLowerCase()}`);
    const attrs = (payload.data as Record<string, any> | undefined)?.attributes ?? {};
    return num(attrs.price_usd);
  } catch {
    return undefined;
  }
}

export interface TokenHolding {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** Human-unit balance. */
  balance: number;
}

/**
 * All ERC-20 balances a wallet holds on Robinhood Chain, via the chain's
 * Blockscout explorer API (keyless). This is what surfaces memecoins bought
 * through `xpay trade` — the on-chain signer only knows a hardcoded token list.
 * Best-effort: returns [] if the explorer is unreachable.
 */
export async function robinhoodHoldings(address: string): Promise<TokenHolding[]> {
  const base = process.env.XPAY_ROBINHOOD_EXPLORER ?? BLOCKSCOUT;
  try {
    const res = await fetch(`${base}/api/v2/addresses/${address}/token-balances`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<Record<string, any>>;
    if (!Array.isArray(rows)) return [];
    const out: TokenHolding[] = [];
    for (const row of rows) {
      const t = row.token ?? {};
      // Only fungible ERC-20s (skip NFTs / ERC-1155).
      if (t.type && t.type !== "ERC-20") continue;
      const addr: string = t.address ?? t.address_hash ?? "";
      const decimals = Number(t.decimals ?? 18);
      const raw = String(row.value ?? "0");
      if (!addr || raw === "0") continue;
      out.push({
        symbol: t.symbol ?? addr.slice(0, 6) + "…",
        name: t.name ?? "",
        address: addr,
        decimals,
        balance: atomsToHuman(raw, decimals),
      });
    }
    // Biggest holdings first.
    return out.sort((a, b) => b.balance - a.balance);
  } catch {
    return [];
  }
}

function atomsToHuman(atoms: string, decimals: number): number {
  const s = atoms.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return Number(`${whole}.${frac}`);
}

/**
 * Resolve a token symbol to its contract address via trending + new pools.
 * Throws when the symbol is unknown or matches several distinct contracts
 * (memecoin symbols are not unique — pass the address instead).
 */
export async function resolveTokenBySymbol(symbol: string): Promise<DiscoveredToken> {
  const wanted = symbol.trim().toUpperCase();
  const [trending, fresh] = await Promise.all([
    trendingTokens({ limit: 20 }),
    newTokens({ limit: 20 }).catch(() => [] as DiscoveredToken[]),
  ]);
  const matches = new Map<string, DiscoveredToken>();
  for (const t of [...trending, ...fresh]) {
    if (t.symbol.toUpperCase() === wanted) matches.set(t.address.toLowerCase(), t);
  }
  if (matches.size === 0) {
    throw new Error(
      `xpay.trade: unknown token "${symbol}" — not in Robinhood Chain trending/new pools. ` +
        "Pass the token's contract address instead.",
    );
  }
  if (matches.size > 1) {
    const list = [...matches.values()].map((t) => `${t.symbol} ${t.address}`).join(", ");
    throw new Error(
      `xpay.trade: symbol "${symbol}" is ambiguous on Robinhood Chain (${list}). ` +
        "Pass the contract address of the one you mean.",
    );
  }
  return [...matches.values()][0]!;
}
