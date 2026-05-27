/**
 * Use — call a paid resource, handling x402 payment end-to-end.
 *
 * Two modes:
 *  - **Catalog mode** (`resource` has `accepts[]`): we pick a requirement up
 *    front, run guardrail, pay, then call with the X-Payment header.
 *  - **Live challenge mode** (`resource.accepts` empty *or* `useByUrl()`): we
 *    call the URL first, expect a `402` with a body listing accepted payment
 *    options, then settle and retry. This is the canonical x402 v2 flow and
 *    lets agents pay resources they discovered *outside* of any catalog.
 *
 * Both paths converge on the same {@link UseResult}.
 */

import {
  type PaymentRequirement,
  type Resource,
  type UseResult,
} from "../types.js";
import type { Wallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";
import { extractRequirements } from "../x402/extract.js";
import { buildSvmPaymentHeader, isSvmNetwork } from "../x402/svm-payment.js";

export interface UseArgs {
  resource: Resource;
  wallet: Wallet;
  guardrail: Guardrail;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function use(args: UseArgs): Promise<UseResult> {
  // If we have accepts up front, take the fast path.
  if (args.resource.accepts.length > 0) {
    return useWithRequirements(args, args.resource.accepts);
  }
  // Otherwise probe the resource for a 402 challenge.
  return useWithLiveChallenge(args);
}

/**
 * Convenience: call any URL with x402 support. Agents can use this when they
 * have a URL but no catalog entry — e.g. crawled from the web.
 */
export interface UseByUrlArgs {
  url: string;
  method?: string;
  wallet: Wallet;
  guardrail: Guardrail;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function useByUrl(args: UseByUrlArgs): Promise<UseResult> {
  const resource: Resource = {
    resource: args.url,
    type: "http",
    method: args.method ?? "GET",
    accepts: [],
  };
  return useWithLiveChallenge({
    resource,
    wallet: args.wallet,
    guardrail: args.guardrail,
    body: args.body,
    headers: args.headers,
  });
}

async function useWithRequirements(
  args: UseArgs,
  reqs: PaymentRequirement[],
): Promise<UseResult> {
  const req = args.wallet.pickRequirement(reqs);
  if (!req) {
    throw new Error(
      `xpay.use: no compatible payment option. Resource accepts: ${reqs.map((a) => a.network).join(", ")}`,
    );
  }

  // Guardrail runs *before* signing — this is the security boundary.
  await args.guardrail.check({ resource: args.resource, requirement: req });

  const settled = await settle(args, req, args.resource.x402Version ?? 1);
  const res = await callResource(args, settled.header);
  return finalize(res, settled.network, req.amount ?? "0", settled.txSig);
}

async function useWithLiveChallenge(args: UseArgs): Promise<UseResult> {
  // Step 1: probe without payment.
  const probe = await callResource(args, undefined);
  if (probe.res.status !== 402) {
    // No payment required — return the probe response as-is. (Useful when a
    // resource later becomes free or for sanity checks.)
    return finalize(probe, "unknown", "0");
  }

  // Step 2: parse the 402 challenge — may live in the body OR a response header.
  const { accepts: reqs } = extractRequirements(probe.res.headers, probe.data);
  if (reqs.length === 0) {
    throw new Error(
      `xpay.use: ${args.resource.resource} returned 402 but no parseable accepts[] in body or headers`,
    );
  }

  const req = args.wallet.pickRequirement(reqs);
  if (!req) {
    throw new Error(
      `xpay.use: ${args.resource.resource} accepts ${reqs.map((r) => r.network).join(", ")} but wallet has no matching signer`,
    );
  }

  await args.guardrail.check({ resource: args.resource, requirement: req });
  const settled = await settle(args, req, 2);

  // Step 3: retry with X-Payment.
  const res = await callResource(args, settled.header);
  return finalize(res, settled.network, req.amount ?? "0", settled.txSig);
}

/**
 * Sign/settle a payment per the requirement and return the X-Payment header
 * value plus accounting fields. Picks the right encoding by network:
 *
 *   SVM (solana / solana:*) + signer has getKitSigner →
 *     canonical x402 v2 — sign-but-don't-broadcast, header carries the
 *     signed tx, facilitator settles. Returns header only (no txSig until
 *     the upstream call comes back).
 *
 *   Anything else (EVM facilitators, legacy v1 SVM) →
 *     legacy path: signer.pay() broadcasts, header carries the txSig.
 */
async function settle(
  args: UseArgs,
  req: PaymentRequirement,
  x402Version: number,
): Promise<{ header: string; network: string; txSig?: string }> {
  const network = normalizeNetwork(req.network);
  const signer = args.wallet.signer(network);

  if (isSvmNetwork(req.network) && typeof signer.getKitSigner === "function") {
    const kitSigner = await signer.getKitSigner();
    const header = await buildSvmPaymentHeader({
      kitSigner,
      requirement: req,
      x402Version,
    });
    return { header, network };
  }

  // Legacy path — sign + broadcast on our side, send txSig in the header.
  const txSig = await signer.pay(req);
  return { header: paymentHeader(req, txSig, x402Version), network, txSig };
}

interface RawResponse {
  res: Response;
  data: unknown;
}

async function callResource(
  args: UseArgs,
  paymentHeader: string | undefined,
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...args.headers,
  };
  if (paymentHeader) headers["x-payment"] = paymentHeader;

  let body: BodyInit | undefined;
  if (args.body !== undefined && args.resource.method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(args.body);
  }

  const res = await fetch(args.resource.resource, {
    method: args.resource.method,
    headers,
    body,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep as string */
  }
  return { res, data };
}

function finalize(
  raw: RawResponse,
  network: string,
  amountPaid: string,
  txSig?: string,
): UseResult {
  if (!raw.res.ok) {
    throw new Error(
      `xpay.use: ${raw.res.status} ${raw.res.statusText} — ${
        typeof raw.data === "string" ? raw.data : JSON.stringify(raw.data)
      }`,
    );
  }
  return {
    data: raw.data,
    status: raw.res.status,
    network,
    amountPaid,
    txSig,
  };
}

/**
 * x402 `X-Payment` header.
 *
 * Format is a base64-encoded JSON blob with the settlement details. Each
 * facilitator validates differently, but the common subset (txSig, payTo,
 * asset, amount, network) is what's encoded here.
 */
function paymentHeader(
  req: PaymentRequirement,
  txSig: string,
  x402Version: number,
): string {
  const payload = {
    scheme: req.scheme,
    network: req.network,
    payTo: req.payTo,
    asset: req.asset,
    amount: req.amount ?? "0",
    txSig,
    x402Version,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function normalizeNetwork(raw: string): string {
  if (raw === "eip155:8453") return "base";
  if (raw === "eip155:1") return "ethereum";
  if (raw === "eip155:42161") return "arbitrum";
  if (raw === "eip155:10") return "optimism";
  // Solana CAIP — any `solana:<genesis>` form collapses to our "solana" slug.
  if (raw === "solana" || raw.startsWith("solana:") || raw.startsWith("solana-")) return "solana";
  return raw;
}
