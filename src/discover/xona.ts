/**
 * Xona first-party discovery (api.xona-agent.com/x402-resources).
 *
 * Xona's own catalog of paid endpoints. The third-party catalogs index almost
 * none of it (Agentic Market carries a few Base mirrors, OrbitX402/PayAI
 * none), so it's fetched directly and ranked ahead of them in discover().
 *
 * Solana routes are the primary rail. The same services are also mirrored on
 * Base, Stable, Arc and SKALE under path prefixes; of those, only the SKALE
 * (`base/*`) mirrors are parsed, and discover() surfaces them only when the
 * caller filters to the skale network, so default results aren't duplicated.
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
/** SKALE on Base, chain 1187947933. Settles bridged USDC.e via PayAI. */
export const SKALE_NETWORK = "eip155:1187947933";
const SKALE_USDC = "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20";
/** Xona's EVM x402 recipient (same on every EVM door). Trust lookups only. */
const XONA_EVM_MERCHANT_WALLET = "0x515e7Bce44Baa5F6e42D16d4B5f27768E7f2F8cC";
/**
 * Xona's Solana x402 recipient, as carried by its live 402s. Published as
 * `metadata.merchantWallet` for trust lookups only: `accepts[].payTo` stays
 * empty so settlement always uses the recipient from the live challenge.
 */
const XONA_MERCHANT_WALLET = "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA";

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
    const key = slugOf(r);
    if (PREFERRED.includes(key)) preferred.push(r);
    else if (DEMOTED.has(key)) demoted.push(r);
    else out.push(r);
  }
  preferred.sort((a, b) => PREFERRED.indexOf(slugOf(a)) - PREFERRED.indexOf(slugOf(b)));
  return [...preferred, ...out, ...demoted];
}

function toResource(item: XonaListing): Resource | null {
  const net = item.pricing?.network;
  if (!item.slug || (net !== "solana-mainnet" && net !== "skale")) return null;
  const skale = net === "skale";

  const accepts: PaymentRequirement[] = [
    {
      asset: skale ? SKALE_USDC : SOLANA_USDC,
      // Not published in the listing; the live 402 carries payTo + feePayer.
      payTo: "",
      amount: toAtomicUsdc(item.pricing?.amount ?? item.price),
      scheme: "exact",
      network: skale ? SKALE_NETWORK : SOLANA_MAINNET,
    },
  ];

  // SKALE slugs carry a `base/` prefix; categorize by what follows it.
  const category = item.slug.split("/")[skale ? 1 : 0];
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
      merchantWallet: skale ? XONA_EVM_MERCHANT_WALLET : XONA_MERCHANT_WALLET,
    },
    inputSchema: item.input_schema,
    outputSchema: item.output_schema ?? null,
  };
}

/** Route slug without the SKALE `base/` prefix, for ranking. */
function slugOf(r: Resource): string {
  return r.resource.slice(RESOURCE_BASE.length + 1).replace(/^base\//, "");
}

function toAtomicUsdc(amount: string | number | undefined): string | undefined {
  if (amount === undefined || amount === "") return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return String(Math.round(n * 1e6));
}
