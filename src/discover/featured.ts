/**
 * Featured partner doors.
 *
 * A short, hand-picked list of third-party x402 endpoints that Xona promotes
 * in discovery. They are already indexed by the big catalogs, but there they
 * compete with 20k+ listings and rarely surface for a plain query. Here they
 * get a reserved slot right after Xona's own matches.
 *
 * The list holds only method + URL. Pricing, recipients and input/output
 * examples come from each door's live 402 challenge (x402 v2 body plus the
 * `bazaar` extension), so a partner's price change shows up without a
 * release. A door whose probe fails is skipped, never guessed.
 */

import type { Resource } from "../types.js";
import { extractRequirements } from "../x402/extract.js";

export interface FeaturedDoor {
  method: "GET" | "POST";
  url: string;
  /** Partner brand, matched by name queries ("kognai", "voxight"). */
  partner: string;
  /** Product line within the partner, e.g. "Golden Kog". */
  product: string;
  /** Single-word names a query can use to ask for this door by name. */
  names: string[];
}

export const FEATURED_DOORS: FeaturedDoor[] = [
  // Kognai: Golden Kog token risk.
  { method: "POST", url: "https://www.kognai.ai/v1/golden-kog/analysis", partner: "Kognai", product: "Golden Kog", names: ["kognai", "kog", "goldenkog"] },
  { method: "POST", url: "https://www.kognai.ai/v1/golden-kog/monitor", partner: "Kognai", product: "Golden Kog", names: ["kognai", "kog", "goldenkog"] },
  // Kognai: Voxight attention signals.
  { method: "GET", url: "https://www.voxight.online/api/coin-attention", partner: "Kognai", product: "Voxight", names: ["kognai", "voxight"] },
  { method: "GET", url: "https://www.voxight.online/api/coin-attention/deep", partner: "Kognai", product: "Voxight", names: ["kognai", "voxight"] },
  { method: "GET", url: "https://www.voxight.online/api/signals/top", partner: "Kognai", product: "Voxight", names: ["kognai", "voxight"] },
  // Kognai: Kreativ reviewed images and clips.
  { method: "POST", url: "https://www.kognai.ai/v1/labor/x402/image", partner: "Kognai", product: "Kreativ", names: ["kognai", "kreativ"] },
  { method: "POST", url: "https://www.kognai.ai/v1/labor/x402/video", partner: "Kognai", product: "Kreativ", names: ["kognai", "kreativ"] },
];

/** Every single-word name a query can use to ask for featured doors. */
export const FEATURED_NAMES: string[] = [...new Set(FEATURED_DOORS.flatMap((d) => d.names))];

const PROBE_TIMEOUT_MS = 8_000;

export interface FeaturedOptions {
  doors?: FeaturedDoor[];
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Probe every featured door for its 402 challenge. Throws only when every
 * probe failed, so discover() records one warning for the source.
 */
export async function fetchFeaturedResources(opts: FeaturedOptions = {}): Promise<Resource[]> {
  const doors = opts.doors ?? FEATURED_DOORS;
  const settled = await Promise.allSettled(doors.map((d) => probeDoor(d, opts)));
  const out: Resource[] = [];
  const errors: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") out.push(s.value);
    else errors.push(`${doors[i].url}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
  });
  if (out.length === 0 && doors.length > 0) {
    throw new Error(`featured: every probe failed (${errors[0]})`);
  }
  return out;
}

async function probeDoor(door: FeaturedDoor, opts: FeaturedOptions): Promise<Resource> {
  const fetchImpl = opts.fetch ?? fetch;
  const init: RequestInit = {
    method: door.method,
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
  };
  if (door.method === "POST") {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = "{}";
  }
  const res = await fetchImpl(door.url, init);
  if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Challenge may be header-only.
  }
  const { accepts, x402Version } = extractRequirements(res.headers, body);
  if (accepts.length === 0) throw new Error("402 carried no payment options");

  const b = (body ?? {}) as {
    resource?: { description?: string; serviceName?: string; tags?: string[]; mimeType?: string };
    extensions?: { bazaar?: { info?: Record<string, unknown> } };
  };
  const info = b.extensions?.bazaar?.info;

  return {
    resource: door.url,
    type: "http",
    method: door.method,
    x402Version,
    accepts,
    lastUpdated: new Date().toISOString(),
    metadata: {
      source: "featured",
      featured: true,
      partner: door.partner,
      serviceName: b.resource?.serviceName ?? `${door.product} by ${door.partner}`,
      product: door.product,
      names: door.names,
      description: b.resource?.description ?? "",
      tags: b.resource?.tags ?? [],
      mimeType: b.resource?.mimeType,
    },
    ...(info ? { inputSchema: info } : {}),
  };
}
