/**
 * Agentic Market discovery client (agentic.market, Coinbase's x402 marketplace).
 *
 * Fast, purpose-built API (~1s responses as of Aug 2026):
 *  - `GET /v1/services?limit=N&offset=M` pages the full catalog (2.3k+ services)
 *  - `GET /v1/services/search?q=...` searches and ranks server-side
 *
 * Listings are service-centric (one service, many endpoints) and carry pricing
 * but NOT payTo/asset settlement details - those come from the live 402
 * challenge at call time. We flatten each endpoint into xpay's Resource shape;
 * the synthesized `accepts[]` entry has enough for network filtering and
 * balance ranking but deliberately lacks EVM domain params, so `use()` takes
 * the live-challenge path instead of trusting the snapshot.
 */

import type { PaymentRequirement, Resource } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.agentic.market/v1/services";
const PAGE_SIZE = 100;
/** Browse-mode cap. The full catalog is 3MB+; one-to-few pages is plenty. */
const DEFAULT_MAX_SERVICES = 200;
const DEFAULT_TIMEOUT_MS = 15_000;

/** USDC contracts per network, used as the display asset in accepts[]. */
const USDC_BY_NETWORK: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export interface AgenticMarketClientOptions {
  endpoint?: string;
  /** Server-side search - omit to browse. */
  query?: string;
  /** Max SERVICES fetched in browse mode (each may yield several resources). */
  maxServices?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface AmParameter {
  group?: string;
  name?: string;
  type?: string;
  description?: string;
  required?: boolean;
  example?: unknown;
  enumValues?: unknown[];
  default?: unknown;
}

interface AmEndpoint {
  url?: string;
  method?: string;
  description?: string;
  pricing?: { amount?: string; currency?: string; network?: string; scheme?: string };
  parameters?: AmParameter[];
  tags?: string[];
  quality?: Record<string, unknown>;
}

interface AmService {
  id?: string;
  name?: string;
  description?: string;
  provider?: string;
  providerUrl?: string;
  category?: string;
  networks?: string[];
  endpoints?: AmEndpoint[];
}

interface AmResponse {
  services?: AmService[];
  total?: number;
  limit?: number;
  offset?: number;
}

export async function fetchAgenticMarketResources(
  opts: AgenticMarketClientOptions = {},
): Promise<Resource[]> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxServices = opts.maxServices ?? DEFAULT_MAX_SERVICES;

  const services: AmService[] = [];

  if (opts.query) {
    // Search endpoint ranks server-side and returns a small set - one call.
    const url = new URL(endpoint.replace(/\/$/, "") + "/search");
    url.searchParams.set("q", opts.query);
    const body = await getJson(fetchImpl, url.toString(), timeoutMs);
    services.push(...(body.services ?? []));
  } else {
    let offset = 0;
    let total = Infinity;
    while (services.length < maxServices && offset < total) {
      const url = new URL(endpoint);
      url.searchParams.set("limit", String(Math.min(PAGE_SIZE, maxServices - services.length)));
      url.searchParams.set("offset", String(offset));
      const body = await getJson(fetchImpl, url.toString(), timeoutMs);
      const page = body.services ?? [];
      services.push(...page);
      total = body.total ?? services.length;
      offset += page.length;
      if (page.length === 0) break;
    }
  }

  const out: Resource[] = [];
  for (const svc of services) {
    for (const ep of svc.endpoints ?? []) {
      const r = toResource(svc, ep);
      if (r) out.push(r);
    }
  }
  return out;
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<AmResponse> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Agentic Market discovery failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as AmResponse;
}

function toResource(svc: AmService, ep: AmEndpoint): Resource | null {
  if (!ep.url) return null;

  const accepts: PaymentRequirement[] = [];
  const network = normalizeNetwork(ep.pricing?.network ?? svc.networks?.[0]);
  if (network) {
    accepts.push({
      asset: USDC_BY_NETWORK[network.toLowerCase()] ?? "USDC",
      // The catalog doesn't publish settlement recipients; the live 402 does.
      // An empty payTo (plus no EVM domain params) keeps use() on the
      // live-challenge path rather than settling against the snapshot.
      payTo: "",
      amount: toAtomicUsdc(ep.pricing?.amount),
      scheme: ep.pricing?.scheme || "exact",
      network,
    });
  }

  return {
    resource: ep.url,
    type: "http",
    method: (ep.method || "POST").toUpperCase(),
    accepts,
    metadata: {
      source: "agenticmarket",
      name: svc.name,
      description: [svc.description, ep.description].filter(Boolean).join(" - "),
      category: svc.category,
      provider: svc.provider,
      providerUrl: svc.providerUrl,
      tags: ep.tags ?? [],
      quality: ep.quality ?? {},
    },
    inputSchema: toInputSchema(ep.parameters),
  };
}

/** Agentic Market labels EVM networks by name ("Base"); map to CAIP-2. */
function normalizeNetwork(net: string | undefined): string | undefined {
  if (!net) return undefined;
  const lower = net.toLowerCase();
  if (lower === "base") return "eip155:8453";
  return net;
}

/** Pricing amounts are decimal USDC strings ("0.003") - convert to 6dp atomic. */
function toAtomicUsdc(amount: string | undefined): string | undefined {
  if (!amount) return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return String(Math.round(n * 1e6));
}

/** Rebuild a JSON Schema from the flat parameter list (body params only). */
function toInputSchema(params: AmParameter[] | undefined): Record<string, unknown> | undefined {
  const body = (params ?? []).filter((p) => p.name && (p.group ?? "body") === "body");
  if (body.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of body) {
    properties[p.name!] = {
      type: p.type || "string",
      ...(p.description ? { description: p.description } : {}),
      ...(Array.isArray(p.enumValues) && p.enumValues.length > 0 ? { enum: p.enumValues } : {}),
      ...(p.default !== null && p.default !== undefined ? { default: p.default } : {}),
    };
    if (p.required) required.push(p.name!);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
