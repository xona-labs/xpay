/**
 * SOL/USD spot price — AgenC listings are priced in native SOL, but the
 * guardrail's policy surface (maxPerTx / maxPerDay / requireApprovalAbove)
 * is USD-denominated. Tries several keyless public feeds in order (corporate
 * proxies commonly block one or another), cached for 60s.
 */

const CACHE_TTL_MS = 60_000;

interface Feed {
  url: string;
  parse(body: unknown): number;
}

const FEEDS: Feed[] = [
  {
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    parse: (b) => Number((b as { solana?: { usd?: number } })?.solana?.usd),
  },
  {
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    parse: (b) => Number((b as { data?: { amount?: string } })?.data?.amount),
  },
  {
    url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
    parse: (b) =>
      Number(
        (b as { result?: Record<string, { c?: string[] }> })?.result?.["SOLUSD"]?.c?.[0],
      ),
  },
];

let cache: { price: number; at: number } | undefined;

export async function solUsdPrice(fetchImpl: typeof fetch = fetch): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.price;

  const errors: string[] = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetchImpl(feed.url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${new URL(feed.url).host}: ${res.status}`);
        continue;
      }
      const price = feed.parse(await res.json());
      if (Number.isFinite(price) && price > 0) {
        cache = { price, at: Date.now() };
        return price;
      }
      errors.push(`${new URL(feed.url).host}: unusable value`);
    } catch (err) {
      errors.push(`${new URL(feed.url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`SOL/USD price unavailable from all feeds (${errors.join("; ")})`);
}
