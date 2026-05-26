/**
 * Discovery — find paid services via OrbitX402.
 *
 * OrbitX402 aggregates multiple x402 catalogs (its own probed resources,
 * PayAI, pay.sh) and returns them in a unified shape. xpay delegates all
 * discovery here rather than managing catalog sources itself.
 */

import type { DiscoverOptions, Resource } from "../types.js";
import { fetchOrbitX402Resources } from "./orbitx402.js";
import { cached } from "./cache.js";

export { setCacheTtl, invalidate as invalidateCache } from "./cache.js";

interface InternalDiscoverOptions extends DiscoverOptions {
  endpoint?: string;
}

export async function discover(opts: InternalDiscoverOptions = {}): Promise<Resource[]> {
  let results = await cached(
    `orbitx402:${opts.endpoint ?? "default"}`,
    () => fetchOrbitX402Resources({ endpoint: opts.endpoint }),
  );

  // Network filter — prefix match so "solana" matches "solana:5eykt4..."
  // and "eip155:8453" matches exactly.
  if (opts.networks?.length) {
    results = results.filter((r) =>
      r.accepts.some((a) =>
        opts.networks!.some((n) => a.network === n || a.network.startsWith(n + ":")),
      ),
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
