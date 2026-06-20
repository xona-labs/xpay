/**
 * Core types for xPay.
 *
 * The {@link Resource} shape mirrors PayAI's facilitator discovery format
 * (https://facilitator.payai.network/discovery/resources) so we can ingest
 * the broader x402 ecosystem without translation.
 */

import { z } from "zod";

/** A network slug. Keep this open-ended so new chains can be added without an SDK release. */
export type Network = "solana" | "base" | "ethereum" | "arbitrum" | "optimism" | (string & {});

/**
 * One payment option attached to a {@link Resource}.
 *
 * A resource may accept multiple options (e.g. USDC on Solana OR USDC on Base);
 * the {@link use} module picks the best one based on wallet balance + fees.
 */
export const PaymentRequirementSchema = z.object({
  /** Token mint (Solana) or contract address (EVM). */
  asset: z.string(),
  /** Recipient address. */
  payTo: z.string(),
  /** Atomic amount as a string (lamports, wei, or token base units). */
  amount: z.string().optional(),
  /** x402 scheme, typically `"exact"`. */
  scheme: z.string(),
  /** Network slug. PayAI uses `"solana"` or EIP-155 strings like `"eip155:8453"`. */
  network: z.string(),
  /** Seconds before the payment intent expires. */
  maxTimeoutSeconds: z.number().optional(),
  mimeType: z.string().optional(),
  extra: z.record(z.unknown()).optional(),
  /** Some PayAI entries duplicate the resource URL inside `accepts[]`. */
  resource: z.string().optional(),
});
export type PaymentRequirement = z.infer<typeof PaymentRequirementSchema>;

/**
 * A discoverable paid HTTP resource.
 *
 * Shape intentionally matches PayAI's discovery item so we can stream their
 * `items[]` straight through. Other catalogs (Pay, Coinbase) are adapted into
 * this shape at the source.
 */
export const ResourceSchema = z.object({
  /** Fully-qualified URL the agent ultimately calls. */
  resource: z.string(),
  /** Always `"http"` today; reserved for future transports. */
  type: z.string(),
  /** HTTP method to invoke. */
  method: z.string().default("GET"),
  /** x402 protocol version of this listing. */
  x402Version: z.number().optional(),
  /** All accepted payment options. */
  accepts: z.array(PaymentRequirementSchema).default([]),
  lastUpdated: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;

/**
 * Facilitator settle envelope, mirrored from the canonical x402
 * `PAYMENT-RESPONSE` header. Present on x402 v2 calls when the facilitator
 * echoes settlement details back to the client; absent on legacy v1 calls.
 */
export interface SettleEnvelope {
  /** Settlement signature / on-chain tx hash. */
  transaction: string;
  /** Address that paid (typically the wallet that signed). */
  payer?: string;
  /** Network identifier in the form the facilitator reports (often CAIP-2). */
  network: string;
  /**
   * Actual amount settled in atomic token units. Equal to the requested
   * amount for `exact` schemes; may differ for `upto` etc.
   */
  amount?: string;
  /** Indicator from the facilitator. */
  success?: boolean;
  /** Provider-specific extensions / extra metadata. */
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** Platform fee charged on every {@link XPay.use} call. */
export interface PlatformFeeResult {
  /** Amount charged in USDC (always 0.01). */
  amount: number;
  /** Settlement tx signature from the platform-fee endpoint. */
  txSig?: string;
  /** Whether the fee was successfully charged. */
  success: boolean;
  /** Error message if the fee charge failed (non-fatal — the use result is still returned). */
  error?: string;
}

/** Result returned by {@link XPay.use}. */
export interface UseResult {
  /** Decoded response body (JSON if possible, else string). */
  data: unknown;
  /** Raw HTTP status from the upstream provider. */
  status: number;
  /** Network the payment settled on. */
  network: Network;
  /** Atomic amount paid. */
  amountPaid: string;
  /**
   * Settlement signature. For SVM v2 calls this comes from the facilitator
   * via the `PAYMENT-RESPONSE` header (we never broadcast client-side).
   * For legacy / EVM v1 calls this is the client-broadcast tx signature.
   */
  txSig?: string;
  /**
   * Full settle envelope from the facilitator, when present in the response.
   * Useful for reconciliation (payer address, actual settled amount, …).
   */
  settlement?: SettleEnvelope;
  /** xPay platform fee of $0.01 USDC charged per pay-per-use call. */
  platformFee?: PlatformFeeResult;
}

/** Options passed to {@link XPay.discover}. */
export interface DiscoverOptions {
  /** Free-text query — matched against resource URL, metadata, and category. */
  query?: string;
  /** Restrict to specific networks. Defaults to all configured. */
  networks?: Network[];
  /** Max results to return. */
  limit?: number;
}

/** A single token balance entry returned by {@link Signer.tokenBalances}. */
export interface TokenBalance {
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  /** SPL mint address (Solana) or ERC-20 contract address (EVM). Absent for native gas tokens. */
  address?: string;
  isNative?: boolean;
}

/** A configured signer for a single network. */
export interface Signer {
  network: Network;
  address: string;
  /**
   * Sign an arbitrary message (used for x402 payment authorization payloads).
   * The exact bytes signed depend on the network — see implementations.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /**
   * Sign and broadcast a token transfer to satisfy a payment requirement.
   * Returns the settlement signature / tx hash.
   */
  pay(req: PaymentRequirement): Promise<string>;
  /**
   * Optional: read the wallet's USDC balance (human units). Defaults to 0 if
   * the signer doesn't implement it.
   */
  balance?(): Promise<number>;
  /**
   * Optional: read all non-zero token balances (native + known tokens).
   * When implemented, shown by `xpay balance` instead of just USDC.
   */
  tokenBalances?(): Promise<TokenBalance[]>;
  /**
   * Optional: return a `@solana/kit` `TransactionSigner` for canonical x402
   * SVM v2 payment payloads. When present, `useByUrl()` will sign the
   * payment transaction without broadcasting and let the facilitator settle;
   * when absent, it falls back to the legacy `pay()` (sign + broadcast,
   * txSig in `X-Payment`).
   *
   * For built-in `rawSolanaSigner` this is implemented out of the box. Custom
   * signers (KMS / MPC) that want v2 support implement it against their
   * signing service.
   */
  getKitSigner?(): Promise<unknown>;
}
