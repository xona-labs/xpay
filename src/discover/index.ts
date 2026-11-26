/**
 * Discovery - find paid services across catalogs.
 *
 * Five sources, merged:
 *  - **Xona** (api.xona-agent.com) - our own Solana endpoints, fetched whole
 *    and matched locally, and ranked ahead of everything else. Xona mirrors
 *    listed by the third-party catalogs (Base etc.) are dropped in favor of it.
 *  - **Featured** - a hand-picked list of partner doors (see ./featured),
 *    probed for their live 402 terms and given a reserved slot right after
 *    Xona's matches. Their copies in the other catalogs are dropped.
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
 * ERC-8004 + SAID agent identity + reputation (`resource.trust`, see ../trust).
 *
 * One source failing never kills discovery - its error is stashed in
 * {@link lastDiscoverWarnings} and the other sources' results are returned.
 *
 * `category: "robotics"` runs a curated set of machine-useful searches
 * (vision, maps, weather, compute, ...) and keeps only results that plainly
 * describe that capability; see ./robotics.
 */

import type { DiscoverOptions, Resource } from "../types.js";
import { fetchOrbitX402Resources } from "./orbitx402.js";
import { fetchPayAIResources } from "./payai.js";
import { fetchAgenticMarketResources } from "./agenticmarket.js";
import { fetchAgencResources } from "../agenc/api.js";
import { SKALE_NETWORK, fetchXonaResources } from "./xona.js";
import { FEATURED_NAMES, fetchFeaturedResources } from "./featured.js";
import { cached, isSourceDown, markSourceDown } from "./cache.js";
import { enrichWithTrust, meetsMinTrust } from "../trust/index.js";
import {
  DISCOVER_CATEGORIES,
  ROBOTICS_FACETS,
  facetsForQuery,
  interleave,
  roboticsFacetOf,
  tagFacet,
  type RoboticsFacet,
} from "./robotics.js";

export { ROBOTICS_FACETS, DISCOVER_CATEGORIES, type RoboticsFacet, type DiscoverCategory } from "./robotics.js";

export { setCacheTtl, invalidate as invalidateCache } from "./cache.js";

interface InternalDiscoverOptions extends DiscoverOptions {
  endpoint?: string;
}

const DEFAULT_SOURCES = ["xona", "featured", "orbitx402", "agenticmarket", "agenc"];

const XONA_HOST = "api.xona-agent.com";

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
  skale: "eip155:1187947933",
};

let warnings: string[] = [];

/** Non-fatal source failures from the most recent {@link discover} call. */
export function lastDiscoverWarnings(): string[] {
  return [...warnings];
}

/**
 * Over-fetch factor when `minTrust` filters results: most merchant wallets
 * have no 8004 identity yet, so a plain `limit` would usually come back empty.
 */
const TRUST_FILTER_POOL = 50;

/** Default page size for a category browse (a single facet would be too few). */
const CATEGORY_DEFAULT_LIMIT = 10;

/** Results kept per robotics facet search before interleaving. */
const ROBOTICS_FACET_POOL = 12;

export async function discover(opts: InternalDiscoverOptions = {}): Promise<Resource[]> {
  if (opts.category !== undefined && !(DISCOVER_CATEGORIES as readonly string[]).includes(opts.category)) {
    throw new Error(
      `xpay.discover: unknown category "${String(opts.category)}" - one of ${DISCOVER_CATEGORIES.join(", ")}`,
    );
  }
  if (opts.category && opts.limit === undefined) opts = { ...opts, limit: CATEGORY_DEFAULT_LIMIT };
  const filtering = opts.minTrust !== undefined;
  const wantTrust = filtering || opts.trust !== false;
  const scoped = filtering ? { ...opts, limit: Math.max(opts.limit ?? 0, TRUST_FILTER_POOL) } : opts;
  const { resources: results, warnings: notes } =
    opts.category === "robotics" ? await discoverRobotics(scoped) : await discoverCatalogs(scoped);
  warnings = notes;
  if (!wantTrust) return results;

  const { resources, failed, saidFailed } = await enrichWithTrust(results);
  if (failed > 0) {
    warnings.push(`8004 trust lookup failed for ${failed} merchant wallet${failed === 1 ? "" : "s"}`);
  }
  if (saidFailed > 0) {
    warnings.push(`SAID lookup failed for ${saidFailed} merchant wallet${saidFailed === 1 ? "" : "s"}`);
  }
  if (!filtering) return resources;
  const kept = resources.filter((r) => meetsMinTrust(r, opts.minTrust!));
  return opts.limit ? kept.slice(0, opts.limit) : kept;
}

interface CatalogResult {
  resources: Resource[];
  warnings: string[];
}

/**
 * Robotics category: one catalog search per facet (or the caller's query plus
 * the facets it names), each filtered to listings that match the facet, then
 * interleaved so every capability shows up near the top. With a query, its
 * own matches come first.
 */
async function discoverRobotics(opts: InternalDiscoverOptions): Promise<CatalogResult> {
  const limit = opts.limit ?? CATEGORY_DEFAULT_LIMIT;
  const query = opts.query?.trim();
  // A query that names facets ("camera", "route") is held to those facets;
  // one that names none may match any of them.
  const named = query ? facetsForQuery(query) : [];
  const searches: Array<{ query: string; facets: RoboticsFacet[] }> = query
    ? [
        { query, facets: named.length > 0 ? named : ROBOTICS_FACETS },
        ...named
          .filter((f) => f.query !== query.toLowerCase())
          .map((f) => ({ query: f.query, facets: [f] })),
      ]
    : ROBOTICS_FACETS.map((f) => ({ query: f.query, facets: [f] }));

  // No limit on the inner search: the facet filter drops most of what the
  // catalogs return, so cap after filtering instead.
  const settled = await Promise.allSettled(
    searches.map((s) => discoverCatalogs({ ...opts, category: undefined, query: s.query, limit: undefined })),
  );

  const notes = new Set<string>();
  const lists: Resource[][] = [];
  let firstError: unknown;
  settled.forEach((res, i) => {
    if (res.status === "rejected") {
      firstError ??= res.reason;
      notes.add(`robotics "${searches[i]!.query}": ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`);
      lists.push([]);
      return;
    }
    for (const w of res.value.warnings) notes.add(w);
    const kept: Resource[] = [];
    for (const r of res.value.resources) {
      const facet = roboticsFacetOf(r, searches[i]!.facets);
      if (facet) kept.push(tagFacet(r, facet));
      if (kept.length >= ROBOTICS_FACET_POOL) break;
    }
    lists.push(kept);
  });
  if (settled.every((s) => s.status === "rejected")) throw firstError;

  const resources = query
    ? interleave([lists[0]!, interleave(lists.slice(1), limit)], Infinity).slice(0, limit)
    : interleave(lists, limit);
  return { resources, warnings: [...notes] };
}

async function discoverCatalogs(opts: InternalDiscoverOptions): Promise<CatalogResult> {
  const query = opts.query?.trim().toLowerCase() || undefined;
  const sources =
    opts.sources ??
    process.env.XPAY_DISCOVERY_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean) ??
    DEFAULT_SOURCES;

  /** Notes from source fetches (e.g. fallback used), returned as warnings. */
  const notes: string[] = [];

  // The query is sent to OrbitX402 and Agentic Market, which search and rank
  // server-side - a small response instead of a full multi-MB catalog
  // download. AgenC's catalog is small enough to fetch whole and filter
  // locally.
  const [xonaSettled, featuredSettled, orbitSettled, marketSettled, agencSettled] = await Promise.allSettled([
    sources.includes("xona")
      ? cached("xona:solana", () => fetchXonaResources())
      : Promise.resolve<Resource[]>([]),
    sources.includes("featured")
      ? cached("featured:doors", () => fetchFeaturedResources())
      : Promise.resolve<Resource[]>([]),
    sources.includes("orbitx402")
      ? fetchOrbitWithPayAIFallback(opts.endpoint, query, notes)
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
  let xona = unwrap(xonaSettled, "xona", failures);
  let featured = unwrap(featuredSettled, "featured", failures);
  let orbit = unwrap(orbitSettled, "orbitx402", failures);
  let market = unwrap(marketSettled, "agenticmarket", failures);
  let agenc = unwrap(agencSettled, "agenc", failures);
  const callWarnings = [...failures, ...notes];

  // The first-party source is authoritative for Xona endpoints (Solana).
  if (xona.length > 0) {
    orbit = orbit.filter((r) => !isXonaResource(r));
    market = market.filter((r) => !isXonaResource(r));
  }
  // Featured doors come with live terms; drop the catalogs' copies.
  if (featured.length > 0) {
    const featuredUrls = new Set(featured.map((r) => r.resource));
    orbit = orbit.filter((r) => !featuredUrls.has(r.resource));
    market = market.filter((r) => !featuredUrls.has(r.resource));
  }

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

    // Xona and AgenC: no server-side search - always match locally. Xona
    // entries lead the results, so they must match at least half the terms
    // (a lone generic word shouldn't pull them up); "xona" itself matches all.
    const xonaTerms = terms.filter((t) => t !== "xona");
    if (xonaTerms.length > 0) {
      xona = rankByScore(xona, xonaTerms, Math.ceil(xonaTerms.length / 2));
    }
    agenc = rankByScore(agenc, terms);

    // Featured doors sit right after Xona, so they get the same bar: half
    // the terms. Naming a partner or product ("kognai", "voxight") pulls in
    // all its doors, ranked by whatever else was asked.
    const namesFeatured = terms.some((t) => FEATURED_NAMES.includes(t));
    const featuredTerms = terms.filter((t) => t !== "xona" && !FEATURED_NAMES.includes(t));
    if (namesFeatured) {
      featured = featured.filter((r) =>
        terms.some((t) => partnerNames(r).includes(t)),
      );
      if (featuredTerms.length > 0) featured = rankByScore(featured, featuredTerms, 0);
    } else if (featuredTerms.length > 0) {
      featured = rankByScore(featured, featuredTerms, Math.ceil(featuredTerms.length / 2));
    } else {
      featured = [];
    }
  }

  // Xona's SKALE mirrors duplicate its Solana routes, so they only show up
  // when the caller asked for SKALE specifically.
  const wantsSkale = opts.networks?.some((n) => (NETWORK_ALIASES[n] ?? n) === SKALE_NETWORK) ?? false;
  if (!wantsSkale) {
    xona = xona.filter((r) => !r.accepts.some((a) => a.network === SKALE_NETWORK));
  }

  // Network filter - prefix match so "solana" matches "solana:5eykt4..."
  // and "eip155:8453" matches exactly. The APIs have no network param yet.
  if (opts.networks?.length) {
    const wanted = opts.networks.map((n) => NETWORK_ALIASES[n] ?? n);
    const matchesNet = (r: Resource) =>
      r.accepts.some((a) =>
        wanted.some((n) => a.network === n || a.network.startsWith(n + ":")),
      );
    xona = xona.filter(matchesNet);
    featured = featured.filter(matchesNet);
    orbit = orbit.filter(matchesNet);
    market = market.filter(matchesNet);
    agenc = agenc.filter(matchesNet);
  }

  // Xona matches lead. With a limit they take at most half the slots, unless
  // the user asked for Xona by name.
  const mentionsXona = query?.includes("xona") ?? false;
  const xonaSlots = opts.limit
    ? Math.min(xona.length, mentionsXona ? opts.limit : Math.ceil(opts.limit / 2))
    : xona.length;
  const lead = xona.slice(0, xonaSlots);

  // Featured doors follow, with a fifth of the slots (at least one), or all
  // remaining slots when the query names the partner.
  const namesFeatured = query?.split(/\s+/).some((t) => FEATURED_NAMES.includes(t)) ?? false;
  const roomAfterXona = opts.limit ? opts.limit - lead.length : Infinity;
  const featuredSlots = Math.min(
    featured.length,
    roomAfterXona,
    opts.limit && !namesFeatured ? Math.max(1, Math.ceil(opts.limit / 5)) : Infinity,
  );
  const partners = featured.slice(0, featuredSlots);

  const used = lead.length + partners.length;
  const rest = mergeOthers(orbit, market, agenc, opts.limit ? opts.limit - used : undefined);
  return { resources: [...lead, ...partners, ...rest], warnings: callWarnings };
}

function partnerNames(r: Resource): string[] {
  const names = r.metadata?.names;
  return Array.isArray(names) ? names.filter((v): v is string => typeof v === "string") : [];
}

function mergeOthers(
  orbit: Resource[],
  market: Resource[],
  agenc: Resource[],
  limit: number | undefined,
): Resource[] {
  if (limit !== undefined && limit <= 0) return [];

  // Merge. When a limit would otherwise be filled entirely from the 20k+ x402
  // catalog, reserve up to a third of the slots for AgenC matches so
  // marketplace listings are never silently drowned out; the remaining slots
  // are split between the two x402 catalogs so neither drowns the other.
  if (limit && agenc.length > 0 && orbit.length + market.length > 0) {
    const agencSlots = Math.min(agenc.length, Math.max(1, Math.ceil(limit / 3)));
    const x402Slots = Math.max(0, limit - agencSlots);
    return [...mergeX402(orbit, market, x402Slots), ...agenc.slice(0, agencSlots)];
  }

  let results = [...mergeX402(orbit, market, limit ?? Infinity), ...agenc];
  if (limit) results = results.slice(0, limit);
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
  notes: string[],
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
      return payAIDirect(query, orbitErr, notes);
    }
  }
  return payAIDirect(query, new Error("orbitx402 in failure cooldown"), notes);
}

async function payAIDirect(query: string | undefined, orbitErr: unknown, notes: string[]): Promise<Resource[]> {
  try {
    const catalog = await cached("payai:fallback", () =>
      fetchPayAIResources({ maxItems: PAYAI_FALLBACK_MAX_ITEMS }),
    );
    notes.push("orbitx402 unavailable, served from PayAI facilitator directly");
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

function isXonaResource(r: Resource): boolean {
  try {
    return new URL(r.resource).hostname === XONA_HOST;
  } catch {
    return false;
  }
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

function rankByScore(resources: Resource[], terms: string[], minScore = 1): Resource[] {
  return resources
    .map((r) => ({ r, score: scoreResource(r, terms) }))
    .filter((x) => x.score >= minScore)
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
