/**
 * Xona for Machines - read-only lookups of machines registered on peaq.
 *
 * peaq is a DePIN chain where robots, drones, sensors and compute nodes get an
 * on-chain identity (a `did:peaq:<id>`). Xona's backend indexes that registry
 * and attaches a machine credit profile (rating, bond, activity, revenue) so
 * an agent can decide whether a machine is worth dealing with.
 *
 * Endpoints (api.xona-agent.com, override with XPAY_MACHINES_ENDPOINT):
 *   GET /api/machines           search, filtered and paged
 *   GET /api/machines/stats     registry totals by category
 *   GET /api/machines/:idOrDid  one machine plus its risk flags
 *
 * Free, read-only: never touches a wallet, a signer or a payment.
 */

const DEFAULT_BASE = "https://api.xona-agent.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export const MACHINE_CATEGORIES = [
  "robot",
  "drone",
  "sensor",
  "compute",
  "vending",
  "arcade",
  "agent",
  "test",
  "other",
] as const;
export type MachineCategory = (typeof MACHINE_CATEGORIES)[number];

export const MACHINE_SORTS = ["activity", "revenue", "recent"] as const;
export type MachineSort = (typeof MACHINE_SORTS)[number];

/** Credit profile the backend attaches to every machine. */
export interface MachineCredit {
  /** "AAA".."B", "NR" (not rated) or "Provisioned" (too new to rate). */
  rating: string;
  /** 0-100. */
  score: number;
  bond_status: string;
  negative_flag: boolean;
  event_count: number;
  revenue_event_count: number;
  activity_event_count: number;
  revenue_usd: number;
  revenue_trend: string;
  /** Indexing gaps: the profile may be incomplete. */
  degraded: boolean;
  updated_at: string;
}

export interface Machine {
  /** Decimal peaq machine id. */
  id: string;
  /** `did:peaq:<id>`. */
  did: string;
  chain: "peaq";
  type: string;
  category: MachineCategory | string;
  /** EVM address that owns the registration. */
  owner: string;
  /** EVM address allowed to operate it. */
  controller: string;
  registered_block: number;
  registered_at: string;
  /** Service endpoints the machine publishes. Empty for nearly all today. */
  endpoints: string[];
  manufacturer: string;
  active: boolean;
  credit: MachineCredit;
  explorer_url?: string;
  /** False when the backend has not caught up to this machine yet. */
  indexed: boolean;
}

/**
 * Known values: unrated, no_activity, negative_flag, unbonded,
 * degraded_data, test_machine. Unknown flags are passed through.
 */
export type MachineFlag = string;

export interface MachineDetail extends Machine {
  flags: MachineFlag[];
}

export interface MachineList {
  total: number;
  items: Machine[];
  indexed_through_block: number;
}

export interface MachineStats {
  registered_total: number;
  legacy_total: number;
  real_total: number;
  by_category: Record<MachineCategory, number>;
  active_total: number;
  with_revenue_total: number;
  rated_total: number;
  indexed_through_block: number;
}

export interface MachineApiOptions {
  /** API origin. Default: XPAY_MACHINES_ENDPOINT or https://api.xona-agent.com. */
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface MachineFindOptions extends MachineApiOptions {
  category?: MachineCategory;
  /** Machine type as registered (free text on peaq, e.g. "robot_arm"). */
  type?: string;
  active?: boolean;
  /** Owner EVM address (0x + 40 hex). */
  owner?: string;
  /** Free-text search. */
  query?: string;
  /** Only machines with a credit rating. */
  rated?: boolean;
  sort?: MachineSort;
  /** 1-100. Server default applies when omitted. */
  limit?: number;
  offset?: number;
  /** Include test machines in results (they are excluded by default). */
  includeTest?: boolean;
}

/** The backend says peaq has no machine registered under this id. */
export class MachineNotFoundError extends Error {
  constructor(public readonly idOrDid: string) {
    super(`xpay.machines: no machine registered on peaq as "${idOrDid}"`);
    this.name = "MachineNotFoundError";
  }
}

const ID_RE = /^(did:peaq:)?\d+$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const TYPE_RE = /^[\w .:/-]+$/;
// peaq machine ids are uint256 token ids: up to 78 decimal digits (real ones
// are 77-78), so the full DID is up to 87 characters. The limit applies to
// the digits, not the prefixed string.
const MAX_ID_DIGITS = 80;
const MAX_TYPE_LEN = 64;
const MAX_QUERY_LEN = 200;

/**
 * Validate a machine id or DID and return it trimmed. Accepts a decimal id
 * (`12345`) or `did:peaq:12345`, with at most 80 digits.
 */
export function normalizeMachineId(input: unknown): string {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new Error("xpay.machines: machine id must be a decimal id or did:peaq:<id>");
  }
  const s = String(input).trim();
  if (!s) throw new Error("xpay.machines: machine id is required");
  // DIDs are case-insensitive in the method prefix only.
  const lowered = s.replace(/^did:peaq:/i, "did:peaq:");
  const digits = lowered.replace(/^did:peaq:/, "");
  if (digits.length > MAX_ID_DIGITS) {
    throw new Error(`xpay.machines: machine id is longer than ${MAX_ID_DIGITS} digits`);
  }
  if (!ID_RE.test(lowered)) {
    throw new Error(`xpay.machines: "${s}" is not a machine id - expected digits or did:peaq:<digits>`);
  }
  return lowered;
}

/** Build the search query string. Exported for tests. */
export function machineSearchParams(opts: MachineFindOptions = {}): URLSearchParams {
  const p = new URLSearchParams();
  if (opts.category !== undefined) {
    if (!(MACHINE_CATEGORIES as readonly string[]).includes(opts.category)) {
      throw new Error(
        `xpay.machines: unknown category "${String(opts.category)}" - one of ${MACHINE_CATEGORIES.join(", ")}`,
      );
    }
    p.set("category", opts.category);
  }
  if (opts.type !== undefined) {
    const t = String(opts.type).trim();
    if (!t || t.length > MAX_TYPE_LEN || !TYPE_RE.test(t)) {
      throw new Error(`xpay.machines: type must be 1-${MAX_TYPE_LEN} letters, digits, spaces or _ . : / -`);
    }
    p.set("type", t);
  }
  if (opts.active !== undefined) p.set("active", opts.active ? "true" : "false");
  if (opts.owner !== undefined) {
    const o = String(opts.owner).trim();
    if (!EVM_RE.test(o)) throw new Error(`xpay.machines: owner must be an EVM address (0x + 40 hex), got "${o}"`);
    p.set("owner", o.toLowerCase());
  }
  if (opts.query !== undefined) {
    const q = String(opts.query).trim();
    if (q.length > MAX_QUERY_LEN) throw new Error(`xpay.machines: query is longer than ${MAX_QUERY_LEN} characters`);
    if (q) p.set("q", q);
  }
  if (opts.rated) p.set("rated", "true");
  if (opts.sort !== undefined) {
    if (!(MACHINE_SORTS as readonly string[]).includes(opts.sort)) {
      throw new Error(`xpay.machines: sort must be one of ${MACHINE_SORTS.join(", ")}`);
    }
    p.set("sort", opts.sort);
  }
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) {
      throw new Error("xpay.machines: limit must be an integer from 1 to 100");
    }
    p.set("limit", String(opts.limit));
  }
  if (opts.offset !== undefined) {
    if (!Number.isInteger(opts.offset) || opts.offset < 0) {
      throw new Error("xpay.machines: offset must be a non-negative integer");
    }
    p.set("offset", String(opts.offset));
  }
  if (opts.includeTest) p.set("include_test", "true");
  return p;
}

/** Search real machines registered on peaq (legacy and test records excluded by default). */
export async function findMachines(opts: MachineFindOptions = {}): Promise<MachineList> {
  const params = machineSearchParams(opts);
  const qs = params.toString();
  return getData<MachineList>(`/api/machines${qs ? `?${qs}` : ""}`, opts);
}

/** One machine by decimal id or `did:peaq:<id>`, with its risk flags. */
export async function getMachine(idOrDid: string, opts: MachineApiOptions = {}): Promise<MachineDetail> {
  const id = normalizeMachineId(idOrDid);
  const m = await getData<MachineDetail>(`/api/machines/${encodeURIComponent(id)}`, opts, id);
  return { ...m, flags: Array.isArray(m.flags) ? m.flags : [] };
}

/** Registry totals: real vs legacy machines, by category, active/rated/with revenue. */
export async function machineStats(opts: MachineApiOptions = {}): Promise<MachineStats> {
  return getData<MachineStats>("/api/machines/stats", opts);
}

function baseUrl(opts: MachineApiOptions): string {
  return (opts.endpoint ?? process.env.XPAY_MACHINES_ENDPOINT ?? DEFAULT_BASE).replace(/\/+$/, "");
}

async function getData<T>(path: string, opts: MachineApiOptions, idForNotFound?: string): Promise<T> {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = baseUrl(opts) + path;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`xpay.machines: machines API timed out after ${timeoutMs}ms`);
    }
    throw new Error(`xpay.machines: machines API unreachable - ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 404 && idForNotFound !== undefined) throw new MachineNotFoundError(idForNotFound);

  let body: { success?: boolean; data?: T; error?: unknown; message?: unknown } | undefined;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = undefined;
  }

  if (!res.ok || !body || body.success === false) {
    const reason = errorText(body) ?? (res.ok ? "unexpected response" : `${res.status} ${res.statusText}`.trim());
    throw new Error(`xpay.machines: ${reason}`);
  }
  if (body.data === undefined || body.data === null || typeof body.data !== "object") {
    throw new Error("xpay.machines: unexpected response shape (no data)");
  }
  return body.data;
}

function errorText(body: { error?: unknown; message?: unknown } | undefined): string | undefined {
  const e = body?.error ?? body?.message;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return undefined;
}

// ------------------------------------------------------------ trust summary

const RATED = /^(AAA|AA|A|BBB|BB|B)$/;

/**
 * One or two plain-language sentences an agent can relay about how much to
 * trust a machine, built from its credit profile and flags. Flags are
 * authoritative when present; otherwise they are derived from `credit`.
 */
export function summarizeMachineTrust(m: Machine & { flags?: MachineFlag[] }): string {
  const c: Partial<MachineCredit> = m.credit ?? {};
  const flags = new Set(m.flags ?? deriveFlags(m));
  const parts: string[] = [];

  if (flags.has("test_machine") || m.category === "test") {
    parts.push("Test machine: registered for testing, not a real device in service.");
  }
  if (flags.has("negative_flag") || c.negative_flag) {
    parts.push("Warning: a negative credit event is on record; treat this machine with caution.");
  }

  // The backend's `unbonded` flag decides when flags came with the record;
  // a list result has none, so read the bond status itself.
  const bonded = m.flags ? !flags.has("unbonded") : /^bonded$/i.test(c.bond_status ?? "");
  const bondText = bonded ? "bonded" : "not bonded";
  const revenueEvents = c.revenue_event_count ?? 0;
  const rating = c.rating ?? "NR";

  if (RATED.test(rating) && !flags.has("unrated")) {
    const usd = formatUsd(c.revenue_usd ?? 0);
    const trend = c.revenue_trend ? `, revenue trend ${c.revenue_trend}` : "";
    parts.push(
      `Rated ${rating} (score ${c.score ?? 0}/100), ${bondText}: ${revenueEvents} revenue event` +
        `${revenueEvents === 1 ? "" : "s"} totalling ${usd}${trend}.`,
    );
  } else if (rating === "Provisioned") {
    parts.push(`Provisioned: newly registered and ${bondText}; too new for a credit rating.`);
  } else if (revenueEvents === 0) {
    const noActivity = flags.has("no_activity") || (c.activity_event_count ?? 0) === 0;
    parts.push(
      `Unrated: registered and ${bondText} but no revenue history yet` +
        `${noActivity ? " and no recorded activity" : ""}.`,
    );
  } else {
    parts.push(`Unrated: registered and ${bondText}, ${revenueEvents} revenue events but not enough history to rate.`);
  }

  if (!m.active) parts.push("Currently inactive.");
  if (flags.has("degraded_data") || c.degraded) {
    parts.push("Credit data is incomplete (indexing gap), so treat the rating as provisional.");
  }
  if (m.indexed === false) parts.push("Not fully indexed yet.");
  if (!m.endpoints?.length) parts.push("It publishes no service endpoints, so there is nothing to call or pay yet.");
  return parts.join(" ");
}

function deriveFlags(m: Machine): MachineFlag[] {
  const c: Partial<MachineCredit> = m.credit ?? {};
  const out: MachineFlag[] = [];
  if (!c.rating || c.rating === "NR") out.push("unrated");
  if ((c.event_count ?? 0) === 0) out.push("no_activity");
  if (c.negative_flag) out.push("negative_flag");
  if (c.bond_status && !/^bonded$/i.test(c.bond_status)) out.push("unbonded");
  if (c.degraded) out.push("degraded_data");
  if (m.category === "test") out.push("test_machine");
  return out;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ------------------------------------------------------------ compact views

/** Machine fields an agent needs, without the raw credit blob. Used by the MCP tools. */
export function compactMachine(m: Machine & { flags?: MachineFlag[] }) {
  const c: Partial<MachineCredit> = m.credit ?? {};
  return {
    id: m.id,
    did: m.did,
    type: m.type,
    category: m.category,
    manufacturer: m.manufacturer || undefined,
    owner: m.owner,
    operator: m.controller,
    active: m.active,
    registered_at: m.registered_at,
    endpoints: m.endpoints ?? [],
    credit: {
      rating: c.rating,
      score: c.score,
      bond_status: c.bond_status,
      negative_flag: c.negative_flag,
      revenue_usd: c.revenue_usd,
      revenue_trend: c.revenue_trend,
      revenue_events: c.revenue_event_count,
      activity_events: c.activity_event_count,
      degraded: c.degraded,
      updated_at: c.updated_at,
    },
    flags: m.flags,
    explorer_url: m.explorer_url,
    summary: summarizeMachineTrust(m),
  };
}
