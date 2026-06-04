/**
 * MagicBlock Private Ephemeral Rollup (PER) client.
 *
 * Implements the three-step flow for private SPL transfers:
 *   1. GET  /v1/spl/challenge  → challenge string
 *   2. POST /v1/spl/login      → bearer token (per-transfer, no caching)
 *   3. POST /v1/spl/transfer   → unsigned tx  →  sign + submit
 *
 * Privacy mechanism: the transfer is routed through MagicBlock's ephemeral
 * rollup using delayed execution + fund splitting, which obscures the amount
 * and recipient on the base chain.
 *
 * Platform model: xpay is the integration layer. End users never need a
 * MagicBlock account — they pass private:true and xpay handles the rest.
 * The challenge/login uses the user's own wallet key (proving transfer
 * authorization), not a separate username/password account.
 *
 * Configuration priority (highest → lowest):
 *   1. MagicBlockConfig passed at call-time (from the active xpay profile)
 *   2. Environment variables  MAGICBLOCK_API_URL / MAGICBLOCK_EPHEMERAL_RPC
 *   3. Built-in defaults
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { Signer } from "../types.js";

const DEFAULTS = {
  apiUrl:       "https://payments.magicblock.app",
  ephemeralRpc: "https://mainnet.magicblock.app/ephemeral",
} as const;

/** Platform-level config, sourced from the xpay profile (set once by the operator). */
export interface MagicBlockConfig {
  /** Override the MagicBlock Payments API base URL. */
  apiUrl?: string;
  /** Override the ephemeral rollup RPC endpoint. */
  ephemeralRpc?: string;
  /** Solana mainnet RPC used for base-route tx submission. Falls back to profile rpcs.solana. */
  solanaRpc?: string;
}

function resolveApi(cfg?: MagicBlockConfig): string {
  return cfg?.apiUrl ?? process.env.MAGICBLOCK_API_URL ?? DEFAULTS.apiUrl;
}
function resolveEphemeralRpc(cfg?: MagicBlockConfig): string {
  return cfg?.ephemeralRpc ?? process.env.MAGICBLOCK_EPHEMERAL_RPC ?? DEFAULTS.ephemeralRpc;
}
function resolveSolanaRpc(cfg?: MagicBlockConfig): string {
  return (
    cfg?.solanaRpc ??
    process.env.MAGICBLOCK_SOLANA_RPC ??
    process.env.XPAY_SOLANA_RPC ??
    "https://solana-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ"
  );
}

// ─── Private transfer ────────────────────────────────────────────────────────

export interface MagicBlockPrivateTransferParams {
  /** xPay Signer for the sender's Solana wallet. */
  signer: Signer;
  /** SPL token mint address. */
  mint: string;
  /** Transfer amount in base units (e.g. 1_000_000 for 1 USDC). */
  amount: bigint;
  /** Recipient Solana address. */
  to: string;
  /** Where the sender's funds currently reside. Defaults to "base" (mainnet). */
  fromBalance?: "base" | "ephemeral";
  /** Where the recipient should receive funds. Defaults to "base" (mainnet). */
  toBalance?: "base" | "ephemeral";
  /**
   * Number of queue entries to split the transfer across (1–15).
   * Higher values increase on-chain privacy by obscuring the amount further.
   * Defaults to 3.
   */
  split?: number;
  /** Platform config (from xpay profile). Falls back to env/defaults when absent. */
  config?: MagicBlockConfig;
}

export interface MagicBlockPrivateTransferResult {
  txSig: string;
  /** Which chain the signed transaction was submitted to. */
  route: "base" | "ephemeral";
}

interface ChallengeResponse  { challenge: string }
interface LoginResponse      { token: string }
interface TransferBuildResponse {
  transactionBase64: string;
  sendTo: "base" | "ephemeral";
  recentBlockhash: string;
  requiredSigners: string[];
}

export async function magicBlockPrivateTransfer(
  params: MagicBlockPrivateTransferParams,
): Promise<MagicBlockPrivateTransferResult> {
  const api    = resolveApi(params.config);
  const pubkey = params.signer.address;

  // ── Step 1: challenge ────────────────────────────────────────────────────
  const challengeRes = await fetch(
    `${api}/v1/spl/challenge?pubkey=${encodeURIComponent(pubkey)}`,
  );
  if (!challengeRes.ok) {
    throw new Error(
      `MagicBlock challenge failed (${challengeRes.status}): ${await challengeRes.text().catch(() => "")}`,
    );
  }
  const { challenge } = (await challengeRes.json()) as ChallengeResponse;

  // ── Step 2: sign + login ─────────────────────────────────────────────────
  const sigBytes  = await params.signer.signMessage(new TextEncoder().encode(challenge));
  const signature = encodeBase58(sigBytes);

  const loginRes = await fetch(`${api}/v1/spl/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ pubkey, challenge, signature }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `MagicBlock login failed (${loginRes.status}): ${await loginRes.text().catch(() => "")}`,
    );
  }
  const { token } = (await loginRes.json()) as LoginResponse;

  // ── Step 3: build unsigned private transfer ──────────────────────────────
  const transferPayload = {
    from:              pubkey,
    to:                params.to,
    mint:              params.mint,
    amount:            Number(params.amount),
    visibility:        "private",
    fromBalance:       params.fromBalance   ?? "base",
    toBalance:         params.toBalance     ?? "base",
    split:             params.split         ?? 3,
    initAtasIfMissing: true,
    initIfMissing:     true,
    legacy:            true,
  };

  const buildRes = await fetch(`${api}/v1/spl/transfer`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(transferPayload),
  });
  if (!buildRes.ok) {
    throw new Error(
      `MagicBlock transfer build failed (${buildRes.status}): ${await buildRes.text().catch(() => "")}`,
    );
  }
  const { transactionBase64, sendTo } = (await buildRes.json()) as TransferBuildResponse;

  // ── Step 4: sign the unsigned transaction ────────────────────────────────
  const tx       = Transaction.from(Buffer.from(transactionBase64, "base64"));
  const msgBytes = tx.serializeMessage();
  const txSigBytes = await params.signer.signMessage(msgBytes);
  tx.addSignature(new PublicKey(pubkey), Buffer.from(txSigBytes));

  // ── Step 5: submit to the correct RPC ────────────────────────────────────
  const rpcUrl     = sendTo === "ephemeral" ? resolveEphemeralRpc(params.config) : resolveSolanaRpc(params.config);
  const connection = new Connection(rpcUrl, "confirmed");

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");

  return { txSig: sig, route: sendTo };
}

// ─── One-time platform setup: initialize mint ────────────────────────────────

export interface InitializeMintParams {
  /** Platform operator's Solana signer. */
  signer: Signer;
  /** SPL token mint to register (e.g. USDC mainnet). */
  mint: string;
  /** Platform config. Falls back to env/defaults. */
  config?: MagicBlockConfig;
}

/**
 * Register an SPL mint with the MagicBlock ephemeral rollup.
 * Call this once per mint from the platform operator's wallet before enabling
 * private transfers. No auth required — this is a permissionless setup.
 */
export async function magicBlockInitializeMint(
  params: InitializeMintParams,
): Promise<string> {
  const api    = resolveApi(params.config);
  const pubkey = params.signer.address;

  const res = await fetch(`${api}/v1/spl/initialize-mint`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ owner: pubkey, mint: params.mint }),
  });
  if (!res.ok) {
    throw new Error(
      `MagicBlock initialize-mint failed (${res.status}): ${await res.text().catch(() => "")}`,
    );
  }
  const { transactionBase64 } = (await res.json()) as { transactionBase64: string };

  const tx       = Transaction.from(Buffer.from(transactionBase64, "base64"));
  const msgBytes = tx.serializeMessage();
  const sigBytes = await params.signer.signMessage(msgBytes);
  tx.addSignature(new PublicKey(pubkey), Buffer.from(sigBytes));

  const connection = new Connection(resolveSolanaRpc(params.config), "confirmed");
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");

  return sig;
}

// ─── Check mint initialization status ────────────────────────────────────────

export async function magicBlockIsMintInitialized(
  mint: string,
  config?: MagicBlockConfig,
): Promise<boolean> {
  const api = resolveApi(config);
  const res = await fetch(`${api}/v1/spl/is-mint-initialized?mint=${encodeURIComponent(mint)}`);
  if (!res.ok) return false;
  const data = (await res.json()) as { initialized?: boolean };
  return Boolean(data.initialized);
}

// ─── Base58 encoding ─────────────────────────────────────────────────────────

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(0);
  for (const b of bytes) n = n * 256n + BigInt(b);

  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n   = n / 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
