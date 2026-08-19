/**
 * MPPScan discovery client - the MPP (Machine Payments Protocol) ecosystem
 * registry at mppscan.com, indexing 350+ live MPP/x402 services on Tempo.
 *
 * The public API (/api/mpp, spec at mppscan.com/openapi.json) is free but
 * SIWX-gated: every route answers 402 with a `sign-in-with-x` challenge
 * (x402 v2 extension, CAIP-122). The client signs the challenge as a SIWE
 * (EIP-4361) message via EIP-191 personal_sign and retries with the
 * `SIGN-IN-WITH-X` header - identity proof only, nothing is paid.
 *
 * Discovered endpoints are payable straight through xpay's use()/pay flow,
 * which settles either protocol (MPP native or x402 fallback).
 */

import type { Wallet } from "../wallet/index.js";
import type { Signer } from "../types.js";

const MPPSCAN_BASE = process.env.XPAY_MPPSCAN_ENDPOINT ?? "https://mppscan.com";

/** SIWX challenge info, as served in the 402 body's extensions. */
interface SiwxInfo {
  domain: string;
  uri: string;
  version: string;
  chainId: string;
  type: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
  statement?: string;
}

export interface MppService {
  id: string;
  name: string;
  description?: string;
  url?: string;
  resourceCount?: number;
  transactions?: number;
  volumeUsd?: number;
  buyers?: number;
  latestTx?: string;
  rank?: number;
}

export interface MppSearchHit {
  origin: string;
  title: string;
  description?: string;
  protocols: string[];
}

export interface MppResource {
  /** Full callable URL (https://{realm}{path}) - pass to use()/pay. */
  url: string;
  method: string;
  summary?: string;
  /** Price in USD. For dynamic pricing this is the base; see pricingMode. */
  priceUsd?: number;
  pricingMode?: string;
  network?: string;
  paymentMethod?: string;
}

/**
 * Pick an EVM signer that can do a plain EIP-191 personal_sign. The SIWX
 * proof is chain-agnostic identity (the challenge names eip155:8453 but any
 * EVM key qualifies); key-holding signers expose the raw ethers Wallet via
 * getEvmWallet, whose signMessage() is exactly personal_sign.
 */
function evmPersonalSigner(wallet: Wallet): { address: string; sign: (msg: string) => Promise<string> } {
  const preferred = ["base", "ethereum", "tempo", ...wallet.networks];
  for (const net of preferred) {
    if (!wallet.has(net)) continue;
    const signer = wallet.signer(net) as Signer & { getEvmWallet?: () => unknown };
    const evm = signer.getEvmWallet?.() as
      | { address: string; signMessage: (m: string) => Promise<string> }
      | undefined;
    if (evm) return { address: evm.address, sign: (m) => evm.signMessage(m) };
  }
  throw new Error("xpay.mpp: MPPScan discovery needs a key-holding EVM signer (base/ethereum) for SIWX sign-in");
}

/** Build the EIP-4361 (SIWE) message string, mirroring siwe's prepareMessage(). */
function siweMessage(info: SiwxInfo, address: string): string {
  const chainRef = info.chainId.includes(":") ? info.chainId.split(":")[1] : info.chainId;
  const suffix = [
    `URI: ${info.uri}`,
    `Version: ${info.version}`,
    `Chain ID: ${Number(chainRef)}`,
    `Nonce: ${info.nonce}`,
    `Issued At: ${info.issuedAt}`,
    ...(info.expirationTime ? [`Expiration Time: ${info.expirationTime}`] : []),
    ...(info.notBefore ? [`Not Before: ${info.notBefore}`] : []),
    ...(info.requestId ? [`Request ID: ${info.requestId}`] : []),
    ...(info.resources?.length
      ? [["Resources:", ...info.resources.map((r) => `- ${r}`)].join("\n")]
      : []),
  ].join("\n");

  let prefix = [
    `${info.domain} wants you to sign in with your Ethereum account:\n${address}`,
    info.statement ?? "",
  ].join("\n\n");
  if (info.statement) prefix += "\n";
  return [prefix, suffix].join("\n");
}

/**
 * Fetch a SIWX-gated URL: probe, sign the challenge, retry with the
 * SIGN-IN-WITH-X header. Non-402 probes are returned as-is.
 */
async function siwxFetch(wallet: Wallet, url: string, init?: RequestInit): Promise<unknown> {
  const probe = await fetch(url, init);
  const probeText = await probe.text();
  let probeData: unknown;
  try {
    probeData = JSON.parse(probeText);
  } catch {
    probeData = probeText;
  }
  if (probe.status !== 402) {
    if (!probe.ok) throw new Error(`xpay.mpp: ${url} returned ${probe.status} ${probe.statusText}`);
    return probeData;
  }

  const info = (probeData as { extensions?: { "sign-in-with-x"?: { info?: SiwxInfo } } })
    ?.extensions?.["sign-in-with-x"]?.info;
  if (!info) {
    throw new Error(`xpay.mpp: ${url} returned 402 without a sign-in-with-x challenge`);
  }
  // The challenge must belong to the origin we contacted; refuse to sign
  // an identity proof bound elsewhere.
  if (info.domain !== new URL(url).host) {
    throw new Error(`xpay.mpp: SIWX challenge domain "${info.domain}" does not match ${new URL(url).host}`);
  }

  const { address, sign } = evmPersonalSigner(wallet);
  const signature = await sign(siweMessage(info, address));
  const payload = { ...info, address, signature };
  const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), "SIGN-IN-WITH-X": header },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`xpay.mpp: ${url} returned ${res.status} ${res.statusText} - ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * List registered MPP services from the MPPScan registry, ranked by usage.
 * `query` is a substring match on name/description server-side.
 */
export async function findMppServices(args: {
  wallet: Wallet;
  query?: string;
  limit?: number;
  sort?: "tx_count" | "total_amount" | "latest_block_timestamp" | "unique_buyers";
}): Promise<MppService[]> {
  const params = new URLSearchParams({
    page_size: String(Math.min(args.limit ?? 10, 100)),
    sort: args.sort ?? "tx_count",
  });
  if (args.query) params.set("q", args.query);
  const data = (await siwxFetch(args.wallet, `${MPPSCAN_BASE}/api/mpp/services?${params}`)) as {
    data?: Array<Record<string, unknown>>;
  };
  return (data.data ?? []).map((s) => {
    const stats = (s.stats ?? {}) as Record<string, unknown>;
    return {
      id: String(s.id),
      name: String(s.name ?? ""),
      description: s.description as string | undefined,
      url: s.url as string | undefined,
      resourceCount: s.resourceCount as number | undefined,
      transactions: stats.transactions as number | undefined,
      volumeUsd: typeof stats.volume === "number" ? Math.round(stats.volume * 100) / 100 : undefined,
      buyers: stats.buyers as number | undefined,
      latestTx: stats.latestTx as string | undefined,
      rank: s.rank as number | undefined,
    };
  });
}

/**
 * Semantic search over the MPP/x402 service index: describe the task in
 * natural language ("web search", "image generation") and get matching
 * service origins with the protocols each speaks.
 */
export async function searchMppServices(args: {
  wallet: Wallet;
  query: string;
  protocol?: "mpp" | "x402";
}): Promise<MppSearchHit[]> {
  const data = (await siwxFetch(args.wallet, `${MPPSCAN_BASE}/api/mpp/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: args.query, ...(args.protocol ? { protocol: args.protocol } : {}) }),
  })) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).map((r) => ({
    origin: String(r.origin ?? ""),
    title: String(r.title ?? ""),
    description: r.description as string | undefined,
    protocols: Array.isArray(r.protocols) ? r.protocols.map(String) : [],
  }));
}

/**
 * List the callable endpoints registered under one MPP service. `service`
 * is a registry id (64-char hex from findMppServices) or a domain/origin,
 * which is resolved via the registry first.
 */
export async function mppServiceResources(args: {
  wallet: Wallet;
  service: string;
}): Promise<{ service: MppService; resources: MppResource[] }> {
  let id = args.service;
  let resolved: MppService | undefined;
  if (!/^[0-9a-f]{64}$/i.test(id)) {
    const domain = id.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const matches = await findMppServices({ wallet: args.wallet, query: domain, limit: 5 });
    resolved = matches.find((m) => m.url?.includes(domain)) ?? matches[0];
    if (!resolved) throw new Error(`xpay.mpp: no registered MPP service matches "${args.service}"`);
    id = resolved.id;
  }

  const data = (await siwxFetch(
    args.wallet,
    `${MPPSCAN_BASE}/api/mpp/services/${id}/resources`,
  )) as { data?: Array<Record<string, unknown>> };

  const resources = (data.data ?? [])
    .filter((r) => !r.deprecated_at)
    .map((r) => ({
      url: `https://${String(r.realm ?? "")}${String(r.path ?? "")}`,
      method: String(r.method ?? "GET"),
      summary: r.summary as string | undefined,
      priceUsd: r.price as number | undefined,
      pricingMode: r.pricing_mode as string | undefined,
      network: r.network as string | undefined,
      paymentMethod: r.payment_method as string | undefined,
    }));

  return {
    service: resolved ?? { id, name: "" },
    resources,
  };
}
