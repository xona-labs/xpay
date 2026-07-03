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
  type PlatformFeeResult,
  type Resource,
  type UseResult,
} from "../types.js";
import type { Wallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";
import { extractRequirements, extractSettleEnvelope } from "../x402/extract.js";
import { buildSvmPaymentHeader, isSvmNetwork } from "../x402/svm-payment.js";
import { isAgencResource } from "../agenc/api.js";
import type { AgencHireConfig } from "../agenc/hire.js";

export interface UseArgs {
  resource: Resource;
  wallet: Wallet;
  guardrail: Guardrail;
  body?: unknown;
  headers?: Record<string, string>;
  /** AgenC hire settings (RPC, review window) — used only for AgenC resources. */
  agenc?: AgencHireConfig;
}

export async function use(args: UseArgs): Promise<UseResult> {
  // AgenC listings are not HTTP resources — payment is an on-chain escrow
  // hire, so branch before any x402 catalog / live-challenge logic.
  if (isAgencResource(args.resource)) {
    const { useAgencHire } = await import("../agenc/hire.js");
    return useAgencHire(args);
  }

  // If we have accepts up front, pick the network we can actually pay on
  // (balance-aware) and take the fast path — unless the chosen option is
  // missing fields that only a live 402 challenge carries.
  if (args.resource.accepts.length > 0) {
    const req = await args.wallet.pickRequirementByBalance(args.resource.accepts);
    if (req) {
      if (!reqNeedsLiveChallenge(args, req)) return useWithRequirements(args, req);
      // Chosen option needs a live 402 (SVM v2 missing feePayer) — fall through.
    } else if (args.wallet.pickRequirement(args.resource.accepts)) {
      // We can sign for an option but no payable network has the funds.
      throw await insufficientBalanceError(args.resource.accepts, args.wallet);
    }
  }
  // Otherwise probe the resource for a 402 challenge.
  return useWithLiveChallenge(args);
}

/**
 * Catalog entries are snapshots — they carry payTo/asset/amount but not the
 * per-facilitator settlement fields. SVM v2 settlement needs
 * `extra.feePayer` (the facilitator's fee-payer pubkey), which only a fresh
 * 402 challenge provides. When it's missing, pay via the live flow instead
 * of failing with "feePayer is required in paymentRequirements.extra".
 */
function reqNeedsLiveChallenge(args: UseArgs, req: PaymentRequirement): boolean {
  if (!isSvmNetwork(req.network)) return false;
  const signer = args.wallet.signer(normalizeNetwork(req.network));
  const usesSvmV2 = typeof signer?.getKitSigner === "function";
  return usesSvmV2 && !req.extra?.feePayer;
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
  req: PaymentRequirement,
): Promise<UseResult> {
  // Guardrail runs *before* signing — this is the security boundary.
  await args.guardrail.check({ resource: args.resource, requirement: req });

  const settled = await settle(args, req, args.resource.x402Version ?? 1);
  const res = await callResource(args, settled.header);
  const result = await finalize(res, settled.network, req.amount ?? "0", settled.txSig);
  result.platformFee = await chargePlatformFee(args.wallet);
  return result;
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

  const req = await args.wallet.pickRequirementByBalance(reqs);
  if (!req) {
    // Distinguish "can't sign anywhere" from "can sign but unfunded".
    if (args.wallet.pickRequirement(reqs)) {
      throw await insufficientBalanceError(reqs, args.wallet);
    }
    throw new Error(
      `xpay.use: ${args.resource.resource} accepts ${reqs.map((r) => r.network).join(", ")} but wallet has no matching signer`,
    );
  }

  await args.guardrail.check({ resource: args.resource, requirement: req });
  const settled = await settle(args, req, 2);

  // Step 3: retry with X-Payment.
  const res = await callResource(args, settled.header);
  const result = await finalize(res, settled.network, req.amount ?? "0", settled.txSig);
  result.platformFee = await chargePlatformFee(args.wallet);
  return result;
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
  if (paymentHeader) {
    // Most x402 servers read `X-PAYMENT`; some (e.g. Nansen) read
    // `Payment-Signature`. The payload is identical, so send both — servers
    // ignore the header name they don't recognise.
    headers["x-payment"] = paymentHeader;
    headers["payment-signature"] = paymentHeader;
  }

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

  // For SVM v2 calls the facilitator broadcasts and echoes settlement details
  // in the `PAYMENT-RESPONSE` header. If present, prefer its signature over
  // any locally-broadcast `txSig` (which only exists on the legacy v1 path).
  const settlement = extractSettleEnvelope(raw.res.headers);

  return {
    data: raw.data,
    status: raw.res.status,
    network,
    amountPaid,
    txSig: settlement?.transaction ?? txSig,
    settlement,
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

const PLATFORM_FEE_URL = "https://api.xona-agent.com/platform-fee";
const PLATFORM_FEE_AMOUNT = 0.01;

/**
 * Charge the xPay platform fee ($0.01 USDC) via the x402 endpoint.
 * Fires after every successful `use` call (including AgenC hires — exported
 * for the agenc module). Non-fatal — a failure is reported in
 * `platformFee.error` rather than throwing.
 */
export async function chargePlatformFee(wallet: Wallet): Promise<PlatformFeeResult> {
  try {
    // Probe the platform-fee endpoint for a 402 challenge.
    const probe = await fetch(PLATFORM_FEE_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ amount: PLATFORM_FEE_AMOUNT }),
    });

    if (probe.status !== 402) {
      return { amount: PLATFORM_FEE_AMOUNT, success: true };
    }

    const probeText = await probe.text();
    let probeData: unknown = probeText;
    try { probeData = JSON.parse(probeText); } catch { /* keep as string */ }

    const { accepts: reqs } = extractRequirements(probe.headers, probeData);
    if (reqs.length === 0) {
      return { amount: PLATFORM_FEE_AMOUNT, success: false, error: "platform-fee: no accepts[] in 402 challenge" };
    }

    const req = wallet.pickRequirement(reqs);
    if (!req) {
      return { amount: PLATFORM_FEE_AMOUNT, success: false, error: `platform-fee: wallet has no signer for ${reqs.map(r => r.network).join(", ")}` };
    }

    // Pay and retry — use a minimal UseArgs stub (no guardrail needed for our own fee).
    const network = normalizeNetwork(req.network);
    const signer = wallet.signer(network);
    let header: string;
    let txSig: string | undefined;

    if (isSvmNetwork(req.network) && typeof signer.getKitSigner === "function") {
      const kitSigner = await signer.getKitSigner();
      header = await buildSvmPaymentHeader({ kitSigner, requirement: req, x402Version: 2 });
    } else {
      txSig = await signer.pay(req);
      header = Buffer.from(JSON.stringify({
        scheme: req.scheme, network: req.network, payTo: req.payTo,
        asset: req.asset, amount: req.amount ?? "0", txSig, x402Version: 2,
      }), "utf8").toString("base64");
    }

    const paid = await fetch(PLATFORM_FEE_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-payment": header },
      body: JSON.stringify({ amount: PLATFORM_FEE_AMOUNT }),
    });

    const settlement = extractSettleEnvelope(paid.headers);
    return {
      amount: PLATFORM_FEE_AMOUNT,
      success: paid.ok,
      txSig: settlement?.transaction ?? txSig,
      ...(paid.ok ? {} : { error: `platform-fee: ${paid.status} ${paid.statusText}` }),
    };
  } catch (err) {
    return {
      amount: PLATFORM_FEE_AMOUNT,
      success: false,
      error: `platform-fee: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build a clear "you can't afford this" error listing the USDC balance on each
 * network the wallet could have paid on. Raised only when every payable option
 * is underfunded — better than attempting a doomed payment and surfacing a raw
 * 402 from the upstream provider.
 */
async function insufficientBalanceError(
  reqs: PaymentRequirement[],
  wallet: UseArgs["wallet"],
): Promise<Error> {
  const nets = [...new Set(reqs.map((r) => normalizeNetwork(r.network)).filter((n) => wallet.has(n)))];
  const parts = await Promise.all(
    nets.map(async (n) => `${n} $${(await wallet.balance(n).catch(() => 0)).toFixed(2)}`),
  );
  return new Error(
    `xpay.use: insufficient USDC balance to pay on any funded network — ${parts.join(", ")}. ` +
      `Fund one of these and retry.`,
  );
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
