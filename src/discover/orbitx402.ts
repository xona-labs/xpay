/**
 * OrbitX402 discovery client.
 *
 * Fetches from api.orbitx402.com/api/x402-discovery which combines
 * orbitx402's own probed resources, PayAI catalog, and pay.sh catalog -
 * all in xpay's Resource shape. Pagination matches PayAI's format.
 *
 * The upstream does per-item work server-side, so latency scales with page
 * size: as of Aug 2026, limit=500 exceeds its gateway's 60s timeout (504)
 * while limit=100 completes. We therefore use small pages, a per-request
 * timeout, and parallel page fetches once the first page reveals the total.
 * Later-page failures degrade to a partial result instead of throwing - the
 * caller caches whatever we got.
 */

import { ResourceSchema, type Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.orbitx402.com/api/x402-discovery";
const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 45_000;
/** Concurrent page fetches after the first page. */
const PAGE_CONCURRENCY = 4;
/** Defensive cap on total pages fetched. */
const MAX_PAGES = 100;

export interface OrbitX402ClientOptions {
  endpoint?: string;
  maxItems?: number;
  limit?: number;
  /** Server-side search - the API ranks and returns only matching resources. */
  query?: string;
  /** Per-request timeout. The upstream 504s around 60s, so waiting longer is pointless. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface OrbitX402Response {
  items?: unknown[];
  pagination?: { limit: number; offset: number; total: number };
}

export async function fetchOrbitX402Resources(opts: OrbitX402ClientOptions = {}): Promise<Resource[]> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const limit = Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE);
  const maxItems = opts.maxItems ?? Infinity;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetch ?? fetch;

  const fetchPage = async (offset: number): Promise<OrbitX402Response> => {
    const url = new URL(endpoint);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (opts.query) url.searchParams.set("query", opts.query);

    const res = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OrbitX402 discovery failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as OrbitX402Response;
  };

  const parseInto = (all: Resource[], rawItems: unknown[]): void => {
    for (const raw of rawItems) {
      if (all.length >= maxItems) return;
      const parsed = ResourceSchema.safeParse(raw);
      if (parsed.success) all.push(parsed.data);
    }
  };

  // First page sequentially - it tells us the total (and whether the server
  // paginates at all).
  const first = await fetchPage(0);
  const all: Resource[] = [];
  const firstItems = first.items ?? [];
  parseInto(all, firstItems);

  if (!first.pagination || firstItems.length < limit || all.length >= maxItems) {
    return all;
  }

  const total = Math.min(first.pagination.total, maxItems);
  const offsets: number[] = [];
  for (let off = firstItems.length; off < total && offsets.length < MAX_PAGES; off += limit) {
    offsets.push(off);
  }

  // Remaining pages in parallel. A page failure (timeout, 504) stops its lane
  // but keeps everything already fetched - partial catalog beats no catalog.
  const pages: Array<{ offset: number; items: unknown[] }> = [];
  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = cursor++;
      if (i >= offsets.length) return;
      try {
        const body = await fetchPage(offsets[i]);
        pages.push({ offset: offsets[i], items: body.items ?? [] });
      } catch {
        failed = true;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));

  // Reassemble in offset order so results stay deterministic.
  pages.sort((a, b) => a.offset - b.offset);
  for (const page of pages) {
    if (all.length >= maxItems) break;
    parseInto(all, page.items);
  }

  return all;
}
