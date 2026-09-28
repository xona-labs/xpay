/**
 * Merchant trust via ERC-8004 (Trustless Agents) on Solana.
 *
 * The 8004-solana registry (QuantuLabs, program 8oo4dC4J…QMbQ) mints each
 * agent as a Metaplex Core asset with an `owner` and an optional operational
 * `agent_wallet`, and stores client feedback (0-100 scores) plus optional
 * ATOM engine scoring (trust tier, quality, confidence, risk). We look up the
 * x402 `payTo` wallet against both fields through the registry's public
 * indexer (keyless PostgREST, 100 req/min per IP).
 *
 * Most merchant wallets have no identity yet, so "not registered" is the
 * common, non-alarming answer - treat trust as a positive signal, not a gate.
 */

import { cached } from "../discover/cache.js";
import type { MerchantTrust, Resource, TrustAgent, TrustTier } from "../types.js";

const DEFAULT_INDEXER = "https://8004-indexer-main.qnt.sh";
const LOOKUP_TIMEOUT_MS = 6_000;
/** Parallel indexer calls when enriching a result list (rate limit is per IP). */
const ENRICH_CONCURRENCY = 8;
/** Enrichment cap - past this, a result list is a catalog dump, not a shortlist. */
const ENRICH_MAX = 50;

const TIERS: TrustTier[] = ["unrated", "bronze", "silver", "gold", "platinum"];
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SELECT =
  "asset,agent_id,owner,agent_wallet,nft_name,agent_uri,atom_enabled," +
  "trust_tier,quality_score,confidence,risk_score,feedback_count,raw_avg_score";

interface IndexedAgentRow {
  asset: string;
  agent_id: number;
  owner: string;
  agent_wallet: string | null;
  nft_name: string | null;
  agent_uri: string | null;
  atom_enabled: boolean;
  trust_tier: number | null;
  quality_score: number | null;
  confidence: number | null;
  risk_score: number | null;
  feedback_count: number | null;
  raw_avg_score: number | null;
}

export interface TrustLookupOptions {
  /** Indexer base URL. Defaults to $XPAY_8004_INDEXER or the mainnet indexer. */
  indexer?: string;
}

/** True when `address` looks like a Solana public key. */
export function isSolanaAddress(address: string): boolean {
  return BASE58_RE.test(address);
}

/**
 * Look up the ERC-8004 identity + reputation linked to a Solana wallet.
 * Cached per wallet (10 min, memory + disk), including "not registered".
 */
export async function lookupMerchantTrust(
  wallet: string,
  opts: TrustLookupOptions = {},
): Promise<MerchantTrust> {
  if (!isSolanaAddress(wallet)) {
    throw new Error(`xpay trust: "${wallet}" is not a Solana address (8004 lookups are Solana-only)`);
  }
  const indexer = (opts.indexer ?? process.env.XPAY_8004_INDEXER ?? DEFAULT_INDEXER).replace(/\/+$/, "");
  return cached<MerchantTrust>(`trust8004:${wallet}`, () => fetchTrust(indexer, wallet));
}

async function fetchTrust(indexer: string, wallet: string): Promise<MerchantTrust> {
  const url =
    `${indexer}/rest/v1/agents?or=(agent_wallet.eq.${wallet},owner.eq.${wallet})` +
    `&select=${SELECT}&limit=50`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`8004 indexer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = (await res.json()) as IndexedAgentRow[];
  const agents = rows.map((r) => toAgent(r, wallet)).sort(compareAgents);
  const agent = agents[0] ?? null;
  return {
    wallet,
    registry: "8004-solana",
    registered: agent !== null,
    agent,
    agentCount: agents.length,
    summary: summarize(agent, agents.length),
  };
}

function toAgent(r: IndexedAgentRow, wallet: string): TrustAgent {
  const feedbackCount = r.feedback_count ?? 0;
  return {
    asset: r.asset,
    agentId: r.agent_id,
    name: r.nft_name ?? undefined,
    uri: r.agent_uri ?? undefined,
    owner: r.owner,
    agentWallet: r.agent_wallet ?? undefined,
    matchedBy: r.agent_wallet === wallet ? "agent_wallet" : "owner",
    feedbackCount,
    avgScore: feedbackCount > 0 && r.raw_avg_score !== null ? r.raw_avg_score : null,
    atom: r.atom_enabled
      ? {
          tier: TIERS[r.trust_tier ?? 0] ?? "unrated",
          // Indexer stores these in basis points (0-10000).
          quality: bps(r.quality_score),
          confidence: bps(r.confidence),
          risk: bps(r.risk_score),
        }
      : undefined,
  };
}

function bps(v: number | null): number {
  return Math.round((v ?? 0) / 100);
}

/** Strongest identity first: ATOM tier, then feedback volume, then score. */
function compareAgents(a: TrustAgent, b: TrustAgent): number {
  const tier = (x: TrustAgent) => (x.atom ? TIERS.indexOf(x.atom.tier) : 0);
  return (
    tier(b) - tier(a) ||
    b.feedbackCount - a.feedbackCount ||
    (b.avgScore ?? -1) - (a.avgScore ?? -1)
  );
}

function summarize(agent: TrustAgent | null, count: number): string {
  if (!agent) return "no ERC-8004 identity";
  const parts = [`8004 agent ${agent.name ? `"${agent.name}"` : `#${agent.agentId}`}`];
  if (agent.atom && agent.atom.tier !== "unrated") parts.push(agent.atom.tier);
  parts.push(
    agent.avgScore !== null
      ? `${agent.avgScore}/100 from ${agent.feedbackCount} review${agent.feedbackCount === 1 ? "" : "s"}`
      : "no reviews yet",
  );
  if (count > 1) parts.push(`+${count - 1} more identit${count === 2 ? "y" : "ies"}`);
  return parts.join(" · ");
}

/** Solana merchant wallet of a resource, if its first payable option has one. */
export function solanaPayTo(r: Resource): string | undefined {
  const opt = r.accepts.find((a) => a.network.startsWith("solana") && a.payTo);
  return opt && isSolanaAddress(opt.payTo) ? opt.payTo : undefined;
}

/**
 * Attach `trust` to Solana-paid resources (first {@link ENRICH_MAX} only).
 * Lookups run with bounded concurrency; a failed lookup leaves `trust` unset
 * and is reported through the returned `failed` count.
 */
export async function enrichWithTrust(
  resources: Resource[],
  opts: TrustLookupOptions = {},
): Promise<{ resources: Resource[]; failed: number }> {
  const head = resources.slice(0, ENRICH_MAX);
  const wallets = [...new Set(head.map(solanaPayTo).filter((w): w is string => !!w))];
  const found = new Map<string, MerchantTrust>();
  let failed = 0;

  let next = 0;
  const worker = async () => {
    while (next < wallets.length) {
      const w = wallets[next++]!;
      try {
        found.set(w, await lookupMerchantTrust(w, opts));
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, wallets.length) }, worker));

  const out = resources.map((r, i) => {
    if (i >= ENRICH_MAX) return r;
    const w = solanaPayTo(r);
    const trust = w ? found.get(w) : undefined;
    return trust ? { ...r, trust } : r;
  });
  return { resources: out, failed };
}

/** Whether a resource's merchant meets a `minTrust` bar (0-100). */
export function meetsMinTrust(r: Resource, minTrust: number): boolean {
  const agent = r.trust?.agent;
  if (!agent) return false;
  return minTrust <= 0 || (agent.avgScore ?? 0) >= minTrust;
}
