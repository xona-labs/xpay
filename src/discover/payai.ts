/**
 * PayAI facilitator client.
 *
 * Source-of-truth for the bulk of xPay's catalog (21k+ x402 resources as of
 * May 2026). The endpoint paginates via `?limit=N&offset=M` and includes a
 * `{ limit, offset, total }` block alongside `items` so we know when to stop.
 */

import { ResourceSchema, type Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://facilitator.payai.network/discovery/resources";
/** PayAI accepts up to 1000 per call as of testing; a single big page is much
 *  cheaper than ten small ones. */
const PAGE_SIZE = 1000;

export interface PayAIClientOptions {
  endpoint?: string;
  /** Hard cap on items fetched across all pages. Defaults to the full catalog. */
  maxItems?: number;
  /** Per-page size hint. Capped at {@link PAGE_SIZE}. */
  limit?: number;
  fetch?: typeof fetch;
}

interface PayAIResponse {
  items?: unknown[];
  pagination?: { limit: number; offset: number; total: number };
}

export async function fetchPayAIResources(opts: PayAIClientOptions = {}): Promise<Resource[]> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const limit = Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE);
  const maxItems = opts.maxItems ?? Infinity;
  const fetchImpl = opts.fetch ?? fetch;

  const all: Resource[] = [];
  let offset = 0;
  let total = Infinity;

  // Defensive page cap: even with limit=1000 and a 100k catalog, 100 pages
  // would be excessive. Real-world we stop at `total`.
  for (let page = 0; page < 100 && offset < total && all.length < maxItems; page++) {
    const url = new URL(endpoint);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const res = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`PayAI discovery failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as PayAIResponse;

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
      // No pagination block — assume single-shot.
      break;
    }
    // Server returned fewer items than requested → we hit the end.
    if (rawItems.length < limit) break;
  }

  return all;
}
