/**
 * AgenC marketplace client — keyless reads of Solana-mainnet marketplace state.
 *
 * AgenC (https://agenc.ag) lists standing service offers from registered
 * on-chain agents. Discovery is a public REST API (cached snapshot of chain
 * state, rebuilt ~every 45s); execution is NOT x402 — hiring escrows native
 * SOL on-chain via `@tetsuo-ai/marketplace-sdk` (see ./hire.ts).
 */

import { z } from "zod";
import type { Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.agenc.ag";
const PAGE_SIZE = 100; // API max

/** Payment scheme marking a resource as an AgenC escrow hire. `use()` dispatches on this. */
export const AGENC_SCHEME = "agenc-hire";

/** Listing shape returned by GET /api/listings. Lamports are u64 decimal strings. */
const AgencListingSchema = z
  .object({
    pda: z.string(),
    providerAgent: z.string(),
    authority: z.string(),
    name: z.string().default(""),
    specHash: z.string(),
    specUri: z.string().nullable().optional(),
    priceLamports: z.string(),
    /** null = priced in native SOL. Anything else is an SPL mint (not hireable). */
    priceMint: z.string().nullable().optional(),
    defaultDeadlineSecs: z.number().optional(),
    operator: z.string().nullable().optional(),
    operatorFeeBps: z.number().optional(),
    /** 0=Active, 1=Paused, 2=Retired */
    state: z.number(),
    maxOpenJobs: z.number().optional(),
    openJobs: z.number().optional(),
    totalHires: z.string().optional(),
    ratingCount: z.number().optional(),
    version: z.string().default("1"),
    createdAtUnix: z.number().optional(),
  })
  .passthrough();
export type AgencListing = z.infer<typeof AgencListingSchema>;

/** Task shape returned by GET /api/tasks/:pda — used to poll hire progress. */
const AgencTaskSchema = z
  .object({
    pda: z.string(),
    title: z.string().optional(),
    status: z.string(),
    rewardLamports: z.string().optional(),
    deadlineUnix: z.number().optional(),
    createdAtUnix: z.number().optional(),
    creatorPda: z.string().optional(),
    workerPda: z.string().nullable().optional(),
  })
  .passthrough();
export type AgencTask = z.infer<typeof AgencTaskSchema>;

export interface AgencClientOptions {
  /** API base. Defaults to https://api.agenc.ag (override: XPAY_AGENC_ENDPOINT). */
  endpoint?: string;
  maxItems?: number;
  fetch?: typeof fetch;
}

interface AgencListingsResponse {
  items?: unknown[];
  page?: number;
  pageSize?: number;
  total?: number;
}

/**
 * Fetch all hireable listings (Active, SOL-priced, moderation-passed) and map
 * them into xpay's Resource shape. The API pre-filters via `hireable=true`;
 * we re-check state/mint per item as belt-and-suspenders.
 */
export async function fetchAgencResources(opts: AgencClientOptions = {}): Promise<Resource[]> {
  const endpoint = opts.endpoint ?? process.env.XPAY_AGENC_ENDPOINT ?? DEFAULT_ENDPOINT;
  const maxItems = opts.maxItems ?? Infinity;
  const fetchImpl = opts.fetch ?? fetch;

  const all: Resource[] = [];
  let total = Infinity;

  for (let page = 1; page <= 100 && all.length < Math.min(total, maxItems); page++) {
    const url = new URL("/api/listings", endpoint);
    url.searchParams.set("hireable", "true");
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));

    const res = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(await apiError("AgenC discovery", res));

    const body = (await res.json()) as AgencListingsResponse;
    const rawItems = body.items ?? [];

    for (const raw of rawItems) {
      const parsed = AgencListingSchema.safeParse(raw);
      if (!parsed.success) continue;
      const l = parsed.data;
      if (l.state !== 0 || (l.priceMint !== null && l.priceMint !== undefined)) continue;
      all.push(listingToResource(l));
      if (all.length >= maxItems) return all;
    }

    total = body.total ?? all.length;
    if (rawItems.length < PAGE_SIZE) break;
  }

  return all;
}

/**
 * Map an AgenC listing into xpay's Resource shape. Everything `hire.ts` needs
 * to execute rides in `accepts[0].extra`, so a discovered resource is
 * self-contained — no extra API round-trips at hire time.
 */
export function listingToResource(l: AgencListing): Resource {
  return {
    resource: `https://agenc.ag/listings/${l.pda}`,
    type: "agenc",
    method: "HIRE",
    accepts: [
      {
        scheme: AGENC_SCHEME,
        network: "solana",
        asset: "SOL",
        payTo: l.authority,
        amount: l.priceLamports,
        ...(l.defaultDeadlineSecs ? { maxTimeoutSeconds: l.defaultDeadlineSecs } : {}),
        extra: {
          listingPda: l.pda,
          specHash: l.specHash,
          version: l.version,
          providerAgent: l.providerAgent,
          operator: l.operator ?? null,
          operatorFeeBps: l.operatorFeeBps ?? 0,
        },
      },
    ],
    metadata: {
      source: "agenc",
      name: l.name,
      listingPda: l.pda,
      specUri: l.specUri ?? null,
      reputation: { ratingCount: l.ratingCount ?? 0, totalHires: l.totalHires ?? "0" },
      capacity: { openJobs: l.openJobs ?? 0, maxOpenJobs: l.maxOpenJobs ?? 0 },
      execution: "solana-escrow-hire",
    },
  };
}

/** Whether a discovered resource is an AgenC listing (executes as an escrow hire, not HTTP). */
export function isAgencResource(r: Resource): boolean {
  return r.accepts.some((a) => a.scheme === AGENC_SCHEME);
}

/**
 * Fetch a single listing by PDA — used as a pre-hire freshness check. The API
 * has no listing-by-pda route, so scan the hireable pages for a match.
 * Returns undefined when the listing is gone or no longer hireable.
 */
export async function fetchAgencListing(
  pda: string,
  opts: AgencClientOptions = {},
): Promise<AgencListing | undefined> {
  const endpoint = opts.endpoint ?? process.env.XPAY_AGENC_ENDPOINT ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetch ?? fetch;

  for (let page = 1; page <= 100; page++) {
    const url = new URL("/api/listings", endpoint);
    url.searchParams.set("hireable", "true");
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));

    const res = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(await apiError("AgenC listing lookup", res));

    const body = (await res.json()) as AgencListingsResponse;
    const rawItems = body.items ?? [];
    for (const raw of rawItems) {
      const parsed = AgencListingSchema.safeParse(raw);
      if (parsed.success && parsed.data.pda === pda) return parsed.data;
    }
    if (rawItems.length < PAGE_SIZE) break;
  }
  return undefined;
}

/** Fetch a task by PDA (GET /api/tasks/:pda) — the status of a hire. */
export async function fetchAgencTask(pda: string, opts: AgencClientOptions = {}): Promise<AgencTask> {
  const endpoint = opts.endpoint ?? process.env.XPAY_AGENC_ENDPOINT ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetch ?? fetch;

  const url = new URL(`/api/tasks/${encodeURIComponent(pda)}`, endpoint);
  const res = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });
  if (res.status === 404) {
    throw new Error(
      `AgenC task ${pda} not found. The API snapshot rebuilds ~every 45s — ` +
        `if this hire just landed, retry in about a minute.`,
    );
  }
  if (!res.ok) throw new Error(await apiError("AgenC task lookup", res));

  const body = (await res.json()) as { task?: unknown };
  const parsed = AgencTaskSchema.safeParse(body.task ?? body);
  if (!parsed.success) {
    throw new Error(`AgenC task lookup: unexpected response shape for ${pda}`);
  }
  return parsed.data;
}

/** Render an API failure, surfacing the `{error}` body and the 503 chain-lag case. */
async function apiError(what: string, res: Response): Promise<string> {
  let reason = "";
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) reason = ` — ${body.error}`;
  } catch {
    /* no JSON body */
  }
  const hint = res.status === 503 ? " (chain snapshot lagging; retry shortly)" : "";
  return `${what} failed: ${res.status} ${res.statusText}${reason}${hint}`;
}
