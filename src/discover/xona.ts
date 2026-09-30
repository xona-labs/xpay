/**
 * Xona first-party discovery (api.xona-agent.com/x402-resources).
 *
 * Xona's own catalog of paid endpoints. The third-party catalogs index almost
 * none of it (Agentic Market carries a few Base mirrors, OrbitX402/PayAI
 * none), so it's fetched directly and ranked ahead of them in discover().
 *
 * Only the Solana routes are surfaced: the same services are also mirrored on
 * Base, Stable and Arc under path prefixes, but Solana is the primary rail.
 *
 * The listing carries pricing but not payTo/feePayer. Like Agentic Market, the
 * synthesized `accepts[]` entry is enough for network filtering and balance
 * ranking; `use()` takes the live-challenge path for the settlement details.
 */

import type { PaymentRequirement, Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.xona-agent.com/x402-resources";
const RESOURCE_BASE = "https://api.xona-agent.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Ranking is a stable sort, so list order breaks ties between equally-scored
 * matches. PREFERRED go first (best image models); DEMOTED go last
 * (creative-director only plans a prompt, it doesn't generate).
 */
const PREFERRED = ["image/gpt-image-2", "image/grok-imagine"];
const DEMOTED = new Set(["image/creative-director"]);

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface XonaClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface XonaListing {
  slug?: string;
  method?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  x402_version?: string;
  price?: number;
  pricing?: { amount?: string; asset?: string; network?: string };
}

export async function fetchXonaResources(opts: XonaClientOptions = {}): Promise<Resource[]> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetch ?? fetch;
  const res = await fetchImpl(endpoint, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Xona discovery failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as XonaListing[];
  if (!Array.isArray(body)) throw new Error("Xona discovery: unexpected response shape");

  const preferred: Resource[] = [];
  const out: Resource[] = [];
  const demoted: Resource[] = [];
  for (const item of body) {
    const r = toResource(item);
    if (!r) continue;
    if (PREFERRED.includes(item.slug!)) preferred.push(r);
    else if (DEMOTED.has(item.slug!)) demoted.push(r);
    else out.push(r);
  }
  preferred.sort((a, b) => PREFERRED.indexOf(slugOf(a)) - PREFERRED.indexOf(slugOf(b)));
  return [...preferred, ...out, ...demoted];
}

function toResource(item: XonaListing): Resource | null {
  if (!item.slug || item.pricing?.network !== "solana-mainnet") return null;

  const accepts: PaymentRequirement[] = [
    {
      asset: SOLANA_USDC,
      // Not published in the listing; the live 402 carries payTo + feePayer.
      payTo: "",
      amount: toAtomicUsdc(item.pricing?.amount ?? item.price),
      scheme: "exact",
      network: SOLANA_MAINNET,
    },
  ];

  const category = item.slug.split("/")[0];
  return {
    resource: `${RESOURCE_BASE}/${item.slug}`,
    type: "http",
    method: (item.method || "POST").toUpperCase(),
    x402Version: item.x402_version === "v1" ? 1 : 2,
    accepts,
    metadata: {
      source: "xona",
      name: `Xona ${item.slug}`,
      description: item.description ?? "",
      category,
      provider: "Xona",
      providerUrl: "https://xona-agent.com",
    },
    inputSchema: item.input_schema,
    outputSchema: item.output_schema ?? null,
  };
}

function slugOf(r: Resource): string {
  return r.resource.slice(RESOURCE_BASE.length + 1);
}

function toAtomicUsdc(amount: string | number | undefined): string | undefined {
  if (amount === undefined || amount === "") return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return String(Math.round(n * 1e6));
}
