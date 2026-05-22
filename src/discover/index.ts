/**
 * Discovery — find paid services across catalogs.
 *
 * v0 wires PayAI as the only source. Pay (the MCP catalog) and xona-labs' own
 * registry slot in here as additional source modules later, all returning the
 * same {@link Resource} shape.
 */

import type { CatalogSource, DiscoverOptions, Resource } from "../types.js";
import { fetchPayAIResources } from "./payai.js";
import { cached } from "./cache.js";

export { setCacheTtl, invalidate as invalidateCache } from "./cache.js";

interface InternalDiscoverOptions extends DiscoverOptions {
  catalogs?: Partial<Record<string, string>>;
}

/**
 * Each source's fetcher runs through the module cache. Cold fetch for the
 * full PayAI catalog is ~50s; cached fetches return in microseconds.
 */
const sourceFetchers: Record<CatalogSource, (endpoint?: string) => Promise<Resource[]>> = {
  payai: (endpoint) =>
    cached(`payai:${endpoint ?? "default"}`, () => fetchPayAIResources({ endpoint })),
  // TODO: pay (Solana Foundation catalog), xona (our own listings).
  pay: async () => [],
  xona: async () => [],
};

/**
 * Fetch resources from each source in parallel, then rank by simple relevance.
 *
 * Ranking v0 is intentionally dumb — token overlap on the URL + metadata. The
 * real moat is in v0.2 ranking (price, reliability, reputation) but we ship
 * with something that works.
 */
export async function discover(opts: InternalDiscoverOptions = {}): Promise<Resource[]> {
  const sources: CatalogSource[] = opts.sources ?? ["payai"];
  const lists = await Promise.all(
    sources.map(async (src) => {
      const fetcher = sourceFetchers[src];
      if (!fetcher) return [];
      try {
        return await fetcher(opts.catalogs?.[src]);
      } catch (err) {
        // One bad source shouldn't kill discovery.
        console.warn(`[xpay] discovery source "${src}" failed:`, err);
        return [];
      }
    }),
  );

  let results = lists.flat();

  // Network filter.
  if (opts.networks?.length) {
    const allowed = new Set(opts.networks);
    results = results.filter((r) =>
      r.accepts.some((a) => allowed.has(normalizeNetwork(a.network))),
    );
  }

  // Query filter + ranking.
  if (opts.query) {
    const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
    results = results
      .map((r) => ({ r, score: scoreResource(r, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }

  if (opts.limit) results = results.slice(0, opts.limit);
  return results;
}

function scoreResource(r: Resource, terms: string[]): number {
  const haystack = [
    r.resource,
    JSON.stringify(r.metadata ?? {}),
    JSON.stringify(r.inputSchema ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (haystack.includes(t)) score += 1;
  }
  return score;
}

function normalizeNetwork(raw: string): string {
  if (raw === "eip155:8453") return "base";
  if (raw === "eip155:1") return "ethereum";
  if (raw === "eip155:42161") return "arbitrum";
  if (raw === "eip155:10") return "optimism";
  return raw;
}
