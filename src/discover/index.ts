/**
 * Discovery — find paid services across catalogs.
 *
 * Two sources, merged:
 *  - **OrbitX402** aggregates multiple x402 catalogs (its own probed
 *    resources, PayAI, pay.sh) and searches/ranks server-side.
 *  - **AgenC** (agenc.ag) lists hireable on-chain agent services, priced in
 *    SOL and executed as escrow hires rather than x402 calls. Its API has no
 *    text search, so queries are matched locally (the catalog is small).
 *
 * One source failing never kills discovery — its error is stashed in
 * {@link lastDiscoverWarnings} and the other source's results are returned.
 */

import type { DiscoverOptions, Resource } from "../types.js";
import { fetchOrbitX402Resources } from "./orbitx402.js";
import { fetchAgencResources } from "../agenc/api.js";
import { cached } from "./cache.js";

export { setCacheTtl, invalidate as invalidateCache } from "./cache.js";

interface InternalDiscoverOptions extends DiscoverOptions {
  endpoint?: string;
}

const DEFAULT_SOURCES = ["orbitx402", "agenc"];

/**
 * Above this many results for a query, assume the endpoint ignored the
 * `query` param (older/custom deployments return the full catalog) and fall
 * back to local filtering. The real API returns a few dozen ranked matches.
 */
const SERVER_QUERY_MAX = 1000;

let warnings: string[] = [];

/** Non-fatal source failures from the most recent {@link discover} call. */
export function lastDiscoverWarnings(): string[] {
  return [...warnings];
}

export async function discover(opts: InternalDiscoverOptions = {}): Promise<Resource[]> {
  const query = opts.query?.trim().toLowerCase() || undefined;
  const sources =
    opts.sources ??
    process.env.XPAY_DISCOVERY_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean) ??
    DEFAULT_SOURCES;

  // The query is sent to OrbitX402, which searches and ranks server-side —
  // a ~50KB response instead of the full multi-MB catalog download. AgenC's
  // catalog is small enough to fetch whole and filter locally.
  const [orbitSettled, agencSettled] = await Promise.allSettled([
    sources.includes("orbitx402")
      ? cached(
          `orbitx402:${opts.endpoint ?? "default"}${query ? `:q=${query}` : ""}`,
          () => fetchOrbitX402Resources({ endpoint: opts.endpoint, query }),
        )
      : Promise.resolve<Resource[]>([]),
    sources.includes("agenc")
      ? cached("agenc:hireable", () => fetchAgencResources())
      : Promise.resolve<Resource[]>([]),
  ]);

  const failures: string[] = [];
  let orbit = unwrap(orbitSettled, "orbitx402", failures);
  let agenc = unwrap(agencSettled, "agenc", failures);
  warnings = failures;

  const enabledCount = DEFAULT_SOURCES.filter((s) => sources.includes(s)).length;
  if (failures.length >= enabledCount && enabledCount > 0) {
    throw new Error(`xpay.discover: all discovery sources failed — ${failures.join("; ")}`);
  }

  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);

    // OrbitX402: local filter + ranking only when the server didn't do it.
    if (orbit.length > SERVER_QUERY_MAX) {
      orbit = rankByScore(orbit, terms);
    }

    // AgenC: no server-side query param — always match locally.
    agenc = rankByScore(agenc, terms);
  }

  // Network filter — prefix match so "solana" matches "solana:5eykt4..."
  // and "eip155:8453" matches exactly. The APIs have no network param yet.
  if (opts.networks?.length) {
    const matchesNet = (r: Resource) =>
      r.accepts.some((a) =>
        opts.networks!.some((n) => a.network === n || a.network.startsWith(n + ":")),
      );
    orbit = orbit.filter(matchesNet);
    agenc = agenc.filter(matchesNet);
  }

  // Merge. When a limit would otherwise be filled entirely from the 20k+ x402
  // catalog, reserve up to a third of the slots for AgenC matches so
  // marketplace listings are never silently drowned out.
  if (opts.limit && orbit.length > 0 && agenc.length > 0) {
    const agencSlots = Math.min(agenc.length, Math.max(1, Math.ceil(opts.limit / 3)));
    const orbitSlots = Math.max(0, opts.limit - agencSlots);
    return [...orbit.slice(0, orbitSlots), ...agenc.slice(0, agencSlots)];
  }

  let results = [...orbit, ...agenc];
  if (opts.limit) results = results.slice(0, opts.limit);
  return results;
}

function unwrap(
  settled: PromiseSettledResult<Resource[]>,
  source: string,
  failures: string[],
): Resource[] {
  if (settled.status === "fulfilled") return settled.value;
  const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
  failures.push(`${source}: ${msg}`);
  return [];
}

function rankByScore(resources: Resource[], terms: string[]): Resource[] {
  return resources
    .map((r) => ({ r, score: scoreResource(r, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
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
