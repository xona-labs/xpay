/**
 * xona shop partner integration: product discovery across Google Shopping,
 * Amazon, and eBay behind xona's x402-paywalled /shop/search endpoint.
 *
 * Flow differs from zauth in one important way: there is a FREE preflight
 * (POST /api/shop/quote) that parses the query server-side and reports the
 * exact price plus whether the query is even a product search. Callers should
 * quote first, then pay: the paid door rejects non-product queries but still
 * charges for the parse, so the free quote is what keeps agents from paying
 * for a query that returns nothing. The search itself is synchronous, so
 * there is no polling step.
 */

export const SHOP_BASE = process.env.XPAY_SHOP_ENDPOINT ?? "https://api.xona-agent.com";

/** Marketplaces the resource can fan out to. Price scales with how many are searched. */
export const SHOP_MARKETPLACES = ["google_shopping", "amazon", "ebay"] as const;

export interface ShopSearchParams {
  /** Free-text shopper query. The only required field; everything else overrides the server-side parse. */
  query: string;
  /** Restrict to a subset of google_shopping / amazon / ebay. Fewer marketplaces means a lower price. */
  marketplaces?: string[];
  price_min?: number;
  price_max?: number;
  /** new | open_box | refurbished | used | for_parts */
  condition?: string;
  /** relevance | price_asc | price_desc | rating | reviews | discount | newest */
  sort?: string;
  country?: string;
  /** Max results after merge/dedupe. Server default 20. */
  limit?: number;
}

export interface ShopQuote {
  success: boolean;
  is_product_query: boolean;
  price_usd: number;
  would_search: string[];
  intent?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Free preflight against /api/shop/quote. No wallet, no SerpAPI credit spent. */
export async function fetchShopQuote(params: ShopSearchParams): Promise<ShopQuote> {
  const res = await fetch(`${SHOP_BASE}/api/shop/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : text.slice(0, 200);
    throw new Error(`shop quote ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return data as ShopQuote;
}

/**
 * Search results carry per-product fields the typical agent never reads
 * (image URLs, marketplace position, internal scoring). Trim each product to
 * the comparison-relevant fields; use the raw payload when full detail
 * matters (CLI --json).
 */
export function compactShopResult(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const { results, ...rest } = data as Record<string, unknown>;
  if (!Array.isArray(results)) return data;
  return {
    ...rest,
    results: results.map((p) => {
      if (typeof p !== "object" || p === null) return p;
      const {
        image: _image,
        product_id: _pid,
        position: _pos,
        sponsored: _sponsored,
        relevance_score: _score,
        badges: _badges,
        ...keep
      } = p as Record<string, unknown>;
      return keep;
    }),
  };
}
