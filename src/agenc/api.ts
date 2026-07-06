/**
 * AgenC marketplace client — keyless reads of Solana-mainnet marketplace state.
 *
 * AgenC (https://agenc.ag) lists standing service offers from registered
 * on-chain agents. Discovery goes through AgenC's hosted indexer via the SDK's
 * `createIndexerClient` — their documented "intended scale read path" (the
 * legacy REST `?hireable=true` filter went dark after a program upgrade).
 * Execution is NOT x402 — hiring escrows native SOL on-chain via
 * `@tetsuo-ai/marketplace-sdk` (see ./hire.ts).
 */

import { z } from "zod";
import type { Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.agenc.ag";

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

/**
 * Fetch all active, SOL-priced listings via AgenC's hosted indexer and map
 * them into xpay's Resource shape. Discovery is deliberately permissive:
 * listings without a fresh moderation attestation are still shown (matching
 * agenc.ag's own browse page) — the hire path is the fail-closed gate.
 */
export async function fetchAgencResources(opts: AgencClientOptions = {}): Promise<Resource[]> {
  const endpoint = opts.endpoint ?? process.env.XPAY_AGENC_ENDPOINT ?? DEFAULT_ENDPOINT;
  const maxItems = opts.maxItems ?? Infinity;

  const { createIndexerClient } = await import("@tetsuo-ai/marketplace-sdk");
  const indexer = createIndexerClient({ baseUrl: endpoint });

  const active = await indexer.listActiveListings({});

  const all: Resource[] = [];
  for (const { address, account } of active) {
    const l = normalizeAccount(address, account as unknown as RawListingAccount);
    if (!l || l.state !== 0 || l.priceMint != null) continue;
    all.push(listingToResource(l));
    if (all.length >= maxItems) break;
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
 * Fetch a single listing by PDA via the indexer — used as the pre-hire
 * freshness check. Decodes the raw on-chain account bytes for byte-true
 * parity with what the program will see. Returns undefined when the listing
 * doesn't exist.
 */
export async function fetchAgencListing(
  pda: string,
  opts: AgencClientOptions = {},
): Promise<AgencListing | undefined> {
  const endpoint = opts.endpoint ?? process.env.XPAY_AGENC_ENDPOINT ?? DEFAULT_ENDPOINT;

  const { createIndexerClient, getServiceListingDecoder, IndexerError } = await import(
    "@tetsuo-ai/marketplace-sdk"
  );
  const indexer = createIndexerClient({ baseUrl: endpoint });

  let row;
  try {
    row = await indexer.getListing(pda);
  } catch (err) {
    if (err instanceof IndexerError && err.status === 404) return undefined;
    throw err;
  }

  const account = getServiceListingDecoder().decode(
    Uint8Array.from(Buffer.from(row.accountData, "base64")),
  ) as unknown as RawListingAccount;
  return normalizeAccount(pda, account) ?? undefined;
}

// ─── On-chain account normalization ──────────────────────────────────────────

/** Decoded ServiceListing account, tolerating JSON-serialized byte arrays / options. */
type ByteLike = Uint8Array | Readonly<Uint8Array> | readonly number[] | number[] | Record<string, number>;

interface RawListingAccount {
  providerAgent: string;
  authority: string;
  name: ByteLike;
  specHash: ByteLike;
  specUri: string;
  price: bigint | string | number;
  priceMint: unknown;
  defaultDeadlineSecs?: bigint | string | number;
  operator?: unknown;
  operatorFeeBps?: number;
  state: number | string;
  maxOpenJobs?: number;
  openJobs?: number;
  totalHires?: bigint | string | number;
  ratingCount?: number;
  version: bigint | string | number;
  createdAt?: bigint | string | number;
}

function toBytes(v: ByteLike): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  return Uint8Array.from(Object.values(v));
}

/** kit codecs serialize Option<T> as `{__option: "Some"|"None", value?}` over JSON. */
function unwrapOption(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && "__option" in (v as Record<string, unknown>)) {
    const o = v as { __option: string; value?: unknown };
    return o.__option === "Some" && o.value != null ? String(o.value) : null;
  }
  return String(v);
}

/** Listing lifecycle state → numeric (indexer may serialize the enum name). */
function toStateNumber(v: number | string): number {
  if (typeof v === "number") return v;
  const byName: Record<string, number> = { active: 0, paused: 1, retired: 2 };
  return byName[v.toLowerCase()] ?? -1;
}

function normalizeAccount(pda: string, a: RawListingAccount): AgencListing | null {
  try {
    return {
      pda,
      providerAgent: String(a.providerAgent),
      authority: String(a.authority),
      name: Buffer.from(toBytes(a.name)).toString("utf8").replace(/\0+$/, ""),
      specHash: Buffer.from(toBytes(a.specHash)).toString("hex"),
      specUri: a.specUri || null,
      priceLamports: BigInt(a.price).toString(),
      priceMint: unwrapOption(a.priceMint),
      defaultDeadlineSecs: a.defaultDeadlineSecs != null ? Number(a.defaultDeadlineSecs) : undefined,
      operator: unwrapOption(a.operator),
      operatorFeeBps: a.operatorFeeBps ?? 0,
      state: toStateNumber(a.state),
      maxOpenJobs: a.maxOpenJobs ?? 0,
      openJobs: a.openJobs ?? 0,
      totalHires: a.totalHires != null ? BigInt(a.totalHires).toString() : "0",
      ratingCount: a.ratingCount ?? 0,
      version: BigInt(a.version).toString(),
      createdAtUnix: a.createdAt != null ? Number(a.createdAt) : undefined,
    };
  } catch {
    return null; // malformed row — skip rather than kill discovery
  }
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
