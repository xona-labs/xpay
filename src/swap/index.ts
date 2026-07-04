/**
 * Native Solana token swap — Jupiter Swap API v2 (order → sign → execute).
 *
 * Swaps happen inside the user's own xpay wallet (funds never leave it), but
 * a swap is irreversible and puts wallet value at risk, so it runs through
 * the same guardrail as payments and transfers — enforced *before* signing.
 *
 * Jupiter's meta-aggregator picks the router (metis / jupiterz / dflow /
 * okx), returns an unsigned v0 transaction, and lands it via POST /execute —
 * no RPC broadcast on our side.
 *
 * Complements the Sana-hosted `sana_swap` (API-key wallet): this path is
 * keyless and uses the local wallet.
 */

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { PaymentRequirement, Resource } from "../types.js";
import type { Wallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";
import {
  jupiterFetch,
  resolveTradeToken,
  NATIVE_SOL_MINT,
  type TokenApiOptions,
  type TokenInfo,
} from "../token/index.js";
import { solUsdPrice } from "../agenc/price.js";

const DEFAULT_ENDPOINT = "https://api.jup.ag";

/** Swap settings — profile `config.swap`, overridable per call / via env. */
export interface SwapConfig {
  /** Max slippage in bps (50 = 0.5%). Unset → Jupiter dynamic slippage. */
  slippageBps?: number;
  /** Jupiter API key for higher rate limits (env: JUPITER_API_KEY). */
  apiKey?: string;
  /** Jupiter API base override (env: XPAY_JUPITER_ENDPOINT). */
  endpoint?: string;
}

export interface SwapArgs {
  /** Human amount of the input token (e.g. 0.5). */
  amount: number;
  /** Input token: symbol (SOL, USDC, BONK, …) or mint address. */
  from: string;
  /** Output token: symbol or mint address. */
  to: string;
  slippageBps?: number;
  wallet: Wallet;
  guardrail: Guardrail;
  config?: SwapConfig;
}

export interface SwapQuote {
  from: TokenInfo;
  to: TokenInfo;
  /** Input in human units / atomic units. */
  inAmount: number;
  inAtoms: string;
  /** Expected output before slippage, human / atomic. */
  outAmount: number;
  outAtoms: string;
  /** Input-side USD value (Jupiter's estimate, else spot price fallback). */
  usdValue?: number;
  priceImpactPct?: number;
  /** Winning router: metis, jupiterz, dflow, okx, … */
  router: string;
  /** Effective slippage for this order (Jupiter dynamic unless overridden). */
  slippageBps?: number;
  /** True when the output token is not Jupiter-verified — relay this warning. */
  outputUnverified: boolean;
}

export interface SwapResult extends SwapQuote {
  network: "solana";
  txSig: string;
  /** Actual totals from execution (include fees), human units. */
  totalInAmount?: number;
  totalOutAmount?: number;
}

/** Quote a swap without executing — no guardrail, no signing, no funds moved. */
export async function swapQuote(args: Omit<SwapArgs, "guardrail">): Promise<SwapQuote> {
  const prepared = await prepare(args);
  return prepared.quote;
}

/** Execute a swap inside the wallet. Guardrail runs before signing. */
export async function swap(args: SwapArgs): Promise<SwapResult> {
  // A quote's transaction embeds a recent blockhash, so always build a fresh
  // order here rather than reusing one from an earlier swapQuote() display.
  const { quote, order, signer, apiOpts } = await prepare(args);

  // Guardrail *before* signing — same security boundary as pay/transfer.
  const requirement: PaymentRequirement = {
    asset: quote.from.mint,
    payTo: quote.to.mint,
    amount: quote.inAtoms,
    scheme: "swap",
    network: "solana",
    extra: {
      usdEstimate: quote.usdValue,
      fromSymbol: quote.from.symbol,
      toSymbol: quote.to.symbol,
    },
  };
  const resource: Resource = {
    resource: `xpay://swap/${quote.from.symbol}-${quote.to.symbol}`,
    type: "swap",
    method: "POST",
    accepts: [requirement],
  };
  await args.guardrail.check({ resource, requirement });

  // Partial-sign the v0 transaction. The signer never exposes its Keypair —
  // sign the serialized message and attach the signature (same pattern as
  // the native-SOL transfer). Do NOT use tx.sign(): it needs a Keypair, and
  // JupiterZ orders may get a market-maker co-signature at /execute, so only
  // our own signature may be added here.
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  const msgBytes = tx.message.serialize();
  const sig = await signer.signMessage(msgBytes);
  tx.addSignature(new PublicKey(signer.address), sig);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

  const endpoint = apiOpts.endpoint ?? DEFAULT_ENDPOINT;
  const exec = (await jupiterFetch(new URL("/swap/v2/execute", endpoint).toString(), apiOpts.apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
  })) as JupiterExecuteResponse;

  if (exec.status !== "Success") {
    const landed = exec.signature
      ? ` The transaction may have landed and reverted — check https://solscan.io/tx/${exec.signature}`
      : "";
    throw new Error(
      `xpay.swap: execution failed (code ${exec.code ?? "?"}) — ${exec.error ?? "unknown error"}.${landed}`,
    );
  }

  return {
    ...quote,
    network: "solana",
    txSig: exec.signature ?? "",
    totalInAmount: atomsToHuman(exec.totalInputAmount, quote.from.decimals),
    totalOutAmount: atomsToHuman(exec.totalOutputAmount, quote.to.decimals),
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

interface JupiterOrderResponse {
  transaction?: string | null;
  requestId?: string;
  inAmount?: string;
  outAmount?: string;
  router?: string;
  slippageBps?: number;
  priceImpactPct?: string | number;
  inUsdValue?: number;
  errorCode?: number;
  errorMessage?: string;
  /** Top-level failure (e.g. "Failed to get quotes") — no errorCode. */
  error?: string;
}

interface JupiterExecuteResponse {
  status: "Success" | "Failed" | string;
  signature?: string;
  code?: number;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
}

async function prepare(args: Omit<SwapArgs, "guardrail"> & { guardrail?: Guardrail }) {
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    throw new Error("xpay.swap: amount must be a positive number");
  }
  if (!args.wallet.has("solana")) {
    throw new Error("xpay.swap: swaps are Solana-only — no Solana signer is configured");
  }
  const signer = args.wallet.signer("solana");

  const apiOpts: TokenApiOptions = {
    endpoint: args.config?.endpoint,
    apiKey: args.config?.apiKey,
  };
  const [from, to] = await Promise.all([
    resolveTradeToken(args.from, apiOpts),
    resolveTradeToken(args.to, apiOpts),
  ]);
  if (from.mint === to.mint) {
    throw new Error(`xpay.swap: input and output are the same token (${from.symbol})`);
  }

  const inAtoms = BigInt(Math.round(args.amount * 10 ** from.decimals));
  if (inAtoms === 0n) {
    throw new Error(
      `xpay.swap: ${args.amount} ${from.symbol} is below the token's smallest unit (${from.decimals} decimals)`,
    );
  }

  const endpoint = apiOpts.endpoint ?? process.env.XPAY_JUPITER_ENDPOINT ?? DEFAULT_ENDPOINT;
  const apiKey = apiOpts.apiKey ?? process.env.JUPITER_API_KEY;
  const slippageBps = args.slippageBps ?? args.config?.slippageBps;

  const url = new URL("/swap/v2/order", endpoint);
  url.searchParams.set("inputMint", from.mint);
  url.searchParams.set("outputMint", to.mint);
  url.searchParams.set("amount", inAtoms.toString());
  url.searchParams.set("taker", signer.address);
  if (slippageBps !== undefined) url.searchParams.set("slippageBps", String(slippageBps));

  const order = (await jupiterFetch(url.toString(), apiKey)) as JupiterOrderResponse;

  if (!order.transaction) {
    // Verified failure shapes: errorCode 1 = wallet lacks the input amount;
    // 2 = wallet lacks SOL for fees; 3 = wallet lacked SOL so Jupiter tried
    // the gasless route, which has a ~$5 minimum. A top-level `error` with no
    // code ("Failed to get quotes") notably happens when slippageBps is set
    // on the keyless tier — dynamic slippage (omitting it) works.
    let reason: string;
    if (order.errorCode === 1) {
      reason = `insufficient ${from.symbol} balance in the wallet`;
    } else if (order.errorCode === 2) {
      reason = "insufficient SOL to cover network fees/rent";
    } else if (order.errorCode === 3) {
      reason =
        "swap is below the gasless route's ~$5 minimum. Jupiter routes gasless when the " +
        "wallet lacks SOL for fees — fund the wallet with SOL, or swap a larger amount";
    } else if (order.error && slippageBps !== undefined) {
      reason = `${order.error} — try again without an explicit slippage (Jupiter picks dynamic slippage)`;
    } else {
      reason = order.errorMessage ?? order.error ?? "Jupiter could not build a swap transaction";
    }
    throw new Error(`xpay.swap: ${reason} (router ${order.router ?? "?"}, code ${order.errorCode ?? "?"})`);
  }

  // Input-side USD: Jupiter's own estimate, else token spot, else SOL feed.
  let usdValue = numOrUndef(order.inUsdValue);
  if (usdValue === undefined && from.usdPrice !== undefined) usdValue = from.usdPrice * args.amount;
  if (usdValue === undefined && from.mint === NATIVE_SOL_MINT) {
    usdValue = await solUsdPrice().then((p) => p * args.amount).catch(() => undefined);
  }

  const outAtoms = order.outAmount ?? "0";
  const quote: SwapQuote = {
    from,
    to,
    inAmount: args.amount,
    inAtoms: inAtoms.toString(),
    outAmount: atomsToHuman(outAtoms, to.decimals) ?? 0,
    outAtoms,
    usdValue,
    priceImpactPct: numOrUndef(Number(order.priceImpactPct)),
    router: order.router ?? "unknown",
    slippageBps: order.slippageBps ?? slippageBps,
    outputUnverified: !to.verified,
  };

  return { quote, order: order as JupiterOrderResponse & { transaction: string }, signer, apiOpts: { endpoint, apiKey } };
}

function atomsToHuman(atoms: string | undefined, decimals: number): number | undefined {
  if (atoms === undefined) return undefined;
  const n = Number(atoms);
  return Number.isFinite(n) ? n / 10 ** decimals : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
