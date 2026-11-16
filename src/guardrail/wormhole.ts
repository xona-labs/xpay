/**
 * Agent Wormhole payment conformance check (optional).
 *
 * The guardrail caps and Bento answer "should the agent spend this?". This
 * answers a different question: "is the payload we just signed the payment
 * the 402 quote asked for?". It runs AFTER signing and BEFORE the X-Payment
 * header leaves the process, so a refusal means nothing is sent and nothing
 * settles (x402 v2 never broadcasts client side).
 *
 * The quote side (payTo, asset, amount, network) comes from the server's 402
 * challenge, never from the model, which is what makes the comparison an
 * independent check rather than the agent grading its own homework.
 *
 *   SVM: decodes the signed transaction inside the header and refuses extra
 *        instructions, approvals, authority changes, wrong mint/recipient/
 *        amount, oversized priority fees.
 *   EVM: recovers the EIP-3009 signer using Wormhole's curated EIP-712 domain
 *        table (not the merchant-supplied `extra.name/version`) and checks
 *        to/value/chain/validity window. Chains missing from that table
 *        (Stable, SKALE, Tempo today) come back `abstain`.
 *
 * On by default. Verdicts: `allow` proceeds, `refuse` always blocks, `abstain`
 * falls back to the local guardrail unless {@link WormholeConfig.onAbstain}
 * says otherwise.
 *
 * `wormhole-x402` is an optionalDependency loaded lazily, same as Bento, and
 * makes no network calls from the entry points used here.
 */

import type { PaymentRequirement } from "../types.js";
import { evmChainId, isEvmNetwork } from "../x402/evm-payment.js";
import { isSvmNetwork } from "../x402/svm-payment.js";

export interface WormholeConfig {
  /**
   * Default: on. `false` disables the check. `true` is a strict opt-in: if
   * wormhole-x402 fails to load the payment is blocked instead of falling back.
   */
  enabled?: boolean;
  /**
   * What to do when Wormhole can't finish the check (unknown EVM domain,
   * Solana lookup-table tx, unsupported scheme). A `refuse` always blocks.
   *   - "fallback" (default): proceed on the local guardrail's checks alone,
   *     warning once per network/asset
   *   - "approve": defer to `onApprovalRequired`, fail closed if none
   *   - "block": always refuse
   */
  onAbstain?: "fallback" | "approve" | "block";
  /**
   * Bind the payment to this wallet (`expectedPayer`). Default true: without
   * it Wormhole checks conformance only, not that *our* wallet is paying.
   */
  bindPayer?: boolean;
  /** Max Solana priority fee in lamports. Default 5_000_000 (0.005 SOL). */
  maxPriorityFeeLamports?: bigint;
}

export interface WormholeFinding {
  code: string;
  severity: string;
  message: string;
}

export interface WormholeVerdict {
  decision: "allow" | "refuse" | "abstain";
  findings: WormholeFinding[];
  reason?: string;
}

export interface VerifyHeaderArgs {
  /** Base64 X-Payment header we built and are about to send. */
  header: string;
  /** The requirement from the live 402 challenge. */
  requirement: PaymentRequirement;
  /** The address that signed (our wallet on that chain). */
  payer: string;
  config: WormholeConfig;
  /** Session nonce set for EVM structural replay detection. */
  seenNonces: Set<string>;
}

/** Returns null when the network isn't one Wormhole covers (caller decides). */
export async function verifyPaymentHeader(args: VerifyHeaderArgs): Promise<WormholeVerdict | null> {
  const req = args.requirement;
  const bind = args.config.bindPayer !== false;

  if (isSvmNetwork(req.network)) {
    const wh = await loadWormhole();
    const quote = {
      payTo: req.payTo,
      asset: req.asset,
      amount: req.amount ?? "0",
      scheme: req.scheme || "exact",
      network: req.network,
      feePayer: typeof req.extra?.feePayer === "string" ? req.extra.feePayer : undefined,
    };
    return wh.inspectPaymentPayload(args.header, quote, {
      expectedPayer: bind ? args.payer : undefined,
      maxPriorityFeeLamports: args.config.maxPriorityFeeLamports ?? 5_000_000n,
    });
  }

  if (isEvmNetwork(req.network)) {
    const evm = await loadWormholeEvm();
    let envelope: { payload?: unknown };
    try {
      envelope = JSON.parse(Buffer.from(args.header, "base64").toString("utf8"));
    } catch {
      return { decision: "abstain", findings: [], reason: "X-Payment header is not base64 JSON" };
    }
    const quote = {
      // Normalize named networks ("base", "skale") to CAIP so Wormhole resolves
      // the chain id the same way our signer did.
      network: `eip155:${evmChainId(req.network)}`,
      asset: req.asset,
      payTo: req.payTo,
      amount: req.amount ?? "0",
      extra: req.extra ?? undefined,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
    };
    return evm.inspectAuthorization(quote, envelope.payload, {
      expectedPayer: bind ? args.payer : undefined,
      seenNonces: args.seenNonces,
      // buildEvmPaymentHeader back-dates validAfter by 600s for clock skew.
      clockSkewSeconds: 600n,
    });
  }

  return null;
}

export function describeVerdict(v: WormholeVerdict): string {
  const codes = v.findings.map((f) => `${f.code}: ${f.message}`).join("; ");
  return [v.reason, codes].filter(Boolean).join(" | ") || "no detail";
}

// -----------------------------------------------------------------------------
// Lazy loaders. Non-literal specifiers keep tsc from requiring the optional
// package at build time.
// -----------------------------------------------------------------------------

interface WormholeSvm {
  inspectPaymentPayload(header: unknown, quote: unknown, opts?: unknown): WormholeVerdict;
}
interface WormholeEvm {
  inspectAuthorization(quote: unknown, payload: unknown, opts?: unknown): Promise<WormholeVerdict>;
}

let svmMod: WormholeSvm | null = null;
let evmMod: WormholeEvm | null = null;

const MISSING =
  "Wormhole is enabled but wormhole-x402 could not be loaded. Install it with " +
  "`npm i wormhole-x402`, or disable guardrail.wormhole.";

async function loadWormhole(): Promise<WormholeSvm> {
  if (svmMod) return svmMod;
  const specifier = "wormhole-x402";
  try {
    svmMod = (await import(specifier)) as unknown as WormholeSvm;
  } catch {
    throw new Error(MISSING);
  }
  return svmMod;
}

async function loadWormholeEvm(): Promise<WormholeEvm> {
  if (evmMod) return evmMod;
  const specifier = "wormhole-x402/evm";
  try {
    evmMod = (await import(specifier)) as unknown as WormholeEvm;
  } catch {
    throw new Error(MISSING);
  }
  return evmMod;
}
