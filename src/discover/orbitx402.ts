/**
 * OrbitX402 discovery client.
 *
 * Fetches from api.orbitx402.com/api/x402-discovery which combines
 * orbitx402's own probed resources, PayAI catalog, and pay.sh catalog —
 * all in xpay's Resource shape. Pagination matches PayAI's format.
 */

import { ResourceSchema, type Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.orbitx402.com/api/x402-discovery";
const PAGE_SIZE = 500;

export interface OrbitX402ClientOptions {
  endpoint?: string;
  maxItems?: number;
  limit?: number;
  /** Server-side search — the API ranks and returns only matching resources. */
  query?: string;
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
  const fetchImpl = opts.fetch ?? fetch;

  const all: Resource[] = [];
  let offset = 0;
  let total = Infinity;

  for (let page = 0; page < 100 && offset < total && all.length < maxItems; page++) {
    const url = new URL(endpoint);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (opts.query) url.searchParams.set("query", opts.query);

    const res = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`OrbitX402 discovery failed: ${res.status} ${res.statusText}`);

    const body = (await res.json()) as OrbitX402Response;
    const rawItems = body.items ?? [];

    for (const raw of rawItems) {
      const parsed = ResourceSchema.safeParse(raw);
      if (parsed.success) all.push(parsed.data);
      if (all.length >= maxItems) return all;
    }

    if (body.pagination) {
      total = body.pagination.total;
      offset = body.pagination.offset + rawItems.length;
    } else {
      break;
    }
    if (rawItems.length < limit) break;
  }

  return all;
}
