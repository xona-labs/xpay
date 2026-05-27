/**
 * Build the canonical x402 SVM v2 `X-Payment` header value using `@x402/svm`.
 *
 * Spec flow:
 *   client signs (does NOT broadcast) → header carries the signed tx →
 *   facilitator verifies + broadcasts on the server side.
 *
 * This is the path xPay 0.1.4+ takes for Solana endpoints reporting
 * `x402Version >= 2` (CAIP networks like `solana:5eykt4…`). Legacy 0.1.x
 * sent a sign-and-broadcast `txSig` header which is *not* what the
 * canonical x402 servers expect — your endpoint would 4xx on the retry.
 *
 * Inputs (the `PaymentRequirement` xPay parsed from the 402 challenge) are
 * normalized into `@x402/core/types`'s `PaymentRequirements` shape.
 */

import { ExactSvmScheme } from "@x402/svm";
import type { PaymentRequirement } from "../types.js";

export interface BuildSvmPaymentArgs {
  /** A `@solana/kit` TransactionSigner — from `signer.getKitSigner()`. */
  kitSigner: unknown;
  /** What the server's 402 told us we owe. */
  requirement: PaymentRequirement;
  /** Optional override RPC URL passed through to `@x402/svm`. */
  rpcUrl?: string;
  /** x402 protocol version observed in the challenge. Defaults to 2. */
  x402Version?: number;
}

/**
 * Returns the value of the `X-Payment` header (base64 of canonical JSON
 * envelope), ready to attach to the retry request.
 */
export async function buildSvmPaymentHeader(args: BuildSvmPaymentArgs): Promise<string> {
  const version = args.x402Version ?? 2;

  // Canonical v2 PaymentRequirements (per @x402/core/schemas):
  //   { payTo, amount, asset, network, scheme, maxTimeoutSeconds, extra? }
  // Note resource/description/mimeType are on the outer PaymentRequired
  // envelope in v2, NOT on the requirements item itself.
  const requirements = {
    payTo: args.requirement.payTo,
    amount: args.requirement.amount ?? "0",
    asset: args.requirement.asset,
    network: args.requirement.network,
    scheme: args.requirement.scheme || "exact",
    maxTimeoutSeconds: args.requirement.maxTimeoutSeconds ?? 300,
    extra: args.requirement.extra ?? undefined,
  };

  // ExactSvmScheme's signer type is the @solana/kit TransactionSigner. Our
  // public Signer surface keeps it as `unknown` so non-SVM signers don't
  // have to pull @solana/kit's types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheme = new ExactSvmScheme(args.kitSigner as any, args.rpcUrl ? { rpcUrl: args.rpcUrl } : undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const partial = await scheme.createPaymentPayload(version, requirements as any);
  // partial = { x402Version, payload: { transaction: <base64 signed tx> } }

  // Assemble the FULL canonical PaymentPayloadV2 envelope:
  //   { x402Version, accepted: <the requirement we're paying>, payload }
  // The `accepted` field is REQUIRED in v2 — it tells the facilitator which
  // of its advertised `accepts[]` items we picked. (Loose top-level
  // scheme/network is v1; v2 nests them inside `accepted`.)
  const envelope = {
    x402Version: partial.x402Version ?? version,
    accepted: requirements,
    payload: partial.payload,
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** True when this network requires the canonical x402 SVM v2 payload. */
export function isSvmNetwork(network: string): boolean {
  return network === "solana" || network.startsWith("solana:") || network.startsWith("solana-");
}
