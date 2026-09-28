/**
 * Discovery - find paid services across catalogs.
 *
 * Three sources, merged:
 *  - **OrbitX402** aggregates multiple x402 catalogs (its own probed
 *    resources, PayAI, pay.sh) and searches/ranks server-side. It has been
 *    slow lately (30-60s/page, queries 504ing), so it runs with tight
 *    timeouts and falls back to the PayAI facilitator directly (~2s for a
 *    1000-item page) when it fails.
 *  - **Agentic Market** (agentic.market, Coinbase's x402 marketplace) with
 *    server-side search, live pricing, and usage-quality metrics.
 *  - **AgenC** (agenc.ag) lists hireable on-chain agent services, priced in
 *    SOL and executed as escrow hires rather than x402 calls. Its API has no
 *    text search, so queries are matched locally (the catalog is small).
 *
 * Solana merchant wallets (`payTo`) in the results are annotated with their
 * ERC-8004 agent identity + reputation (`resource.trust`, see ../trust).
 *
 * One source failing never kills discovery - its error is stashed in
 * {@link lastDiscoverWarnings} and the other sources' results are returned.
 */

import type { DiscoverOptions, Resource } from "../types.js";
import { fetchOrbitX402Resources } from "./orbitx402.js";
import { fetchPayAIResources } from "./payai.js";
import { fetchAgenticMarketResources } from "./agenticmarket.js";
import { fetchAgencResources } from "../agenc/api.js";
import { cached, isSourceDown, markSourceDown } from "./cache.js";
import { enrichWithTrust, meetsMinTrust } from "../trust/index.js";

export { setCacheTtl, invalidate as invalidateCache } from "./cache.js";

interface InternalDiscoverOptions extends DiscoverOptions {
  endpoint?: string;
}

const DEFAULT_SOURCES = ["orbitx402", "agenticmarket", "agenc"];

/**
 * Cap on items pulled from OrbitX402. With a query the server ranks and
 * returns a few dozen, so this never binds; without one it stops us from
 * paging a 20k+ catalog through an upstream currently doing 30s/page.
 */
const ORBIT_MAX_ITEMS = 600;

/** PayAI-fallback catalog size. Three 1000-item pages, ~6s cold. */
const PAYAI_FALLBACK_MAX_ITEMS = 3000;

/**
 * Per-request budget for OrbitX402. Healthy responses land well under this;
 * its gateway 504s at ~60s, so anything longer only delays the fallback.
 */
const ORBIT_TIMEOUT_MS = 20_000;

/** How long a failed OrbitX402 call routes traffic straight to PayAI. */
const ORBIT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Above this many results for a query, assume the endpoint ignored the
 * `query` param (older/custom deployments return the full catalog) and fall
 * back to local filtering. The real API returns a few dozen ranked matches.
 */
const SERVER_QUERY_MAX = 1000;

/**
 * Named EVM slugs → the CAIP-2 id catalogs actually publish. Without this,
 * filtering on `stable` or `base` matches nothing, since every EVM listing
 * carries `eip155:<id>`.
 */
const NETWORK_ALIASES: Record<string, string> = {
  base: "eip155:8453",
  ethereum: "eip155:1",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  robinhood: "eip155:4663",
  stable: "eip155:988",
};

let warnings: string[] = [];
/** Notes queued by in-flight source fetches (e.g. fallback used), folded into
 *  {@link warnings} once the call settles. */
let pendingNotes: string[] = [];

/** Non-fatal source failures from the most recent {@link discover} call. */
export function lastDiscoverWarnings(): string[] {
  return [...warnings];
}

/**
 * Over-fetch factor when `minTrust` filters results: most merchant wallets
 * have no 8004 identity yet, so a plain `limit` would usually come back empty.
 */
const TRUST_FILTER_POOL = 50;

export async function discover(opts: InternalDiscoverOptions = {}): Promise<Resource[]> {
  const filtering = opts.minTrust !== undefined;
  const wantTrust = filtering || opts.trust !== false;
  const results = await discoverCatalogs(
    filtering ? { ...opts, limit: Math.max(opts.limit ?? 0, TRUST_FILTER_POOL) } : opts,
  );
  if (!wantTrust) return results;

  const { resources, failed } = await enrichWithTrust(results);
  if (failed > 0) {
    warnings.push(`8004 trust lookup failed for ${failed} merchant wallet${failed === 1 ? "" : "s"}`);
  }
  if (!filtering) return resources;
  const kept = resources.filter((r) => meetsMinTrust(r, opts.minTrust!));
  return opts.limit ? kept.slice(0, opts.limit) : kept;
}

async function discoverCatalogs(opts: InternalDiscoverOptions): Promise<Resource[]> {
  const query = opts.query?.trim().toLowerCase() || undefined;
  const sources =
    opts.sources ??
    process.env.XPAY_DISCOVERY_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean) ??
    DEFAULT_SOURCES;

  pendingNotes = [];

  // The query is sent to OrbitX402 and Agentic Market, which search and rank
  // server-side - a small response instead of a full multi-MB catalog
  // download. AgenC's catalog is small enough to fetch whole and filter
  // locally.
  const [orbitSettled, marketSettled, agencSettled] = await Promise.allSettled([
    sources.includes("orbitx402")
      ? fetchOrbitWithPayAIFallback(opts.endpoint, query)
      : Promise.resolve<Resource[]>([]),
    sources.includes("agenticmarket")
      ? cached(`agenticmarket${query ? `:q=${query}` : ""}`, () =>
          fetchAgenticMarketResources({ query }),
        )
      : Promise.resolve<Resource[]>([]),
    sources.includes("agenc")
      ? cached("agenc:hireable", () => fetchAgencResources())
      : Promise.resolve<Resource[]>([]),
  ]);

  const failures: string[] = [];
  let orbit = unwrap(orbitSettled, "orbitx402", failures);
  let market = unwrap(marketSettled, "agenticmarket", failures);
  let agenc = unwrap(agencSettled, "agenc", failures);
  warnings = [...failures, ...pendingNotes];

  const enabledCount = DEFAULT_SOURCES.filter((s) => sources.includes(s)).length;
  if (failures.length >= enabledCount && enabledCount > 0) {
    throw new Error(`xpay.discover: all discovery sources failed - ${failures.join("; ")}`);
  }

  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);

    // Server-searched sources: local filter + ranking only when the server
    // clearly didn't do it (full catalog came back).
    if (orbit.length > SERVER_QUERY_MAX) {
      orbit = rankByScore(orbit, terms);
    }
    if (market.length > SERVER_QUERY_MAX) {
      market = rankByScore(market, terms);
    }

    // AgenC: no server-side query param - always match locally.
    agenc = rankByScore(agenc, terms);
  }

  // Network filter - prefix match so "solana" matches "solana:5eykt4..."
  // and "eip155:8453" matches exactly. The APIs have no network param yet.
  if (opts.networks?.length) {
    const wanted = opts.networks.map((n) => NETWORK_ALIASES[n] ?? n);
    const matchesNet = (r: Resource) =>
      r.accepts.some((a) =>
        wanted.some((n) => a.network === n || a.network.startsWith(n + ":")),
      );
    orbit = orbit.filter(matchesNet);
    market = market.filter(matchesNet);
    agenc = agenc.filter(matchesNet);
  }

  // Merge. When a limit would otherwise be filled entirely from the 20k+ x402
  // catalog, reserve up to a third of the slots for AgenC matches so
  // marketplace listings are never silently drowned out; the remaining slots
  // are split between the two x402 catalogs so neither drowns the other.
  if (opts.limit && agenc.length > 0 && orbit.length + market.length > 0) {
    const agencSlots = Math.min(agenc.length, Math.max(1, Math.ceil(opts.limit / 3)));
    const x402Slots = Math.max(0, opts.limit - agencSlots);
    return [...mergeX402(orbit, market, x402Slots), ...agenc.slice(0, agencSlots)];
  }

  let results = [...mergeX402(orbit, market, opts.limit ?? Infinity), ...agenc];
  if (opts.limit) results = results.slice(0, opts.limit);
  return results;
}

/**
 * OrbitX402 with a direct-PayAI safety net. Orbit aggregates PayAI anyway, so
 * when it's down or timing out, PayAI's facilitator gives us most of the same
 * catalog at a fraction of the latency (query is then ranked locally).
 */
async function fetchOrbitWithPayAIFallback(
  endpoint: string | undefined,
  query: string | undefined,
): Promise<Resource[]> {
  // A recent orbit failure puts it in a cooldown window (persisted to disk, so
  // fresh CLI processes benefit too) - go straight to PayAI instead of
  // re-paying the timeout on every call.
  if (!isSourceDown("orbitx402")) {
    try {
      return await cached(
        `orbitx402:${endpoint ?? "default"}${query ? `:q=${query}` : ""}`,
        () =>
          fetchOrbitX402Resources({
            endpoint,
            query,
            maxItems: ORBIT_MAX_ITEMS,
            timeoutMs: ORBIT_TIMEOUT_MS,
          }),
      );
    } catch (orbitErr) {
      markSourceDown("orbitx402", ORBIT_COOLDOWN_MS);
      return payAIDirect(query, orbitErr);
    }
  }
  return payAIDirect(query, new Error("orbitx402 in failure cooldown"));
}

async function payAIDirect(query: string | undefined, orbitErr: unknown): Promise<Resource[]> {
  try {
    const catalog = await cached("payai:fallback", () =>
      fetchPayAIResources({ maxItems: PAYAI_FALLBACK_MAX_ITEMS }),
    );
    pendingNotes.push("orbitx402 unavailable, served from PayAI facilitator directly");
    if (!query) return catalog;
    return rankByScore(catalog, query.split(/\s+/).filter(Boolean));
  } catch {
    throw orbitErr;
  }
}

/**
 * Interleave the two x402 catalogs' top results (orbit first - it ranks
 * server-side across more sources) up to `limit` combined items.
 */
function mergeX402(orbit: Resource[], market: Resource[], limit: number): Resource[] {
  const out: Resource[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (out.length < limit && (i < orbit.length || i < market.length)) {
    for (const r of [orbit[i], market[i]]) {
      if (!r || out.length >= limit) continue;
      // Both catalogs can list the same underlying resource URL.
      const key = `${r.method} ${r.resource}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    i++;
  }
  return out;
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
