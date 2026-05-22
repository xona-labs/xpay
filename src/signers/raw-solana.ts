/**
 * Raw Solana signer — for tests, server-side agents, and other scenarios where
 * you hold a Solana keypair directly.
 *
 * Production wallets should prefer Privy or Phantom signers.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import type { PaymentRequirement, Signer } from "../types.js";

/** Mainnet USDC mint. Used for the default balance lookup. */
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export interface RawSolanaSignerOptions {
  /** Base58 secret key (64 bytes) or a 64-byte Uint8Array. */
  secretKey: string | Uint8Array;
  /** Solana RPC. Defaults to public mainnet (rate-limited, swap for prod). */
  rpcUrl?: string;
}

export function rawSolanaSigner(opts: RawSolanaSignerOptions): Signer {
  const secret = typeof opts.secretKey === "string"
    ? decodeBase58(opts.secretKey)
    : opts.secretKey;
  const keypair = Keypair.fromSecretKey(secret);
  const connection = new Connection(opts.rpcUrl ?? DEFAULT_RPC, "confirmed");

  return {
    network: "solana",
    address: keypair.publicKey.toBase58(),

    async signMessage(message) {
      const sig = nacl.sign.detached(message, keypair.secretKey);
      return sig;
    },

    async balance(): Promise<number> {
      try {
        const mint = new PublicKey(USDC_MINT_MAINNET);
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey);
        const acc = await getAccount(connection, ata);
        // USDC has 6 decimals.
        return Number(acc.amount) / 1_000_000;
      } catch {
        // Account doesn't exist yet → 0 balance.
        return 0;
      }
    },

    /**
     * Pay an SPL token (typically USDC) per the requirement.
     *
     * v0 builds the transfer naively. A production version should batch with
     * the resource request (e.g. via x402 facilitator) and use versioned
     * transactions + priority fees.
     */
    async pay(req: PaymentRequirement): Promise<string> {
      const mint = new PublicKey(req.asset);
      const recipient = new PublicKey(req.payTo);
      const amount = BigInt(req.amount ?? "0");

      const fromAta = await getOrCreateAssociatedTokenAccount(
        connection,
        keypair,
        mint,
        keypair.publicKey,
      );
      const toAta = await getOrCreateAssociatedTokenAccount(
        connection,
        keypair,
        mint,
        recipient,
      );

      const tx = new Transaction().add(
        createTransferInstruction(fromAta.address, toAta.address, keypair.publicKey, amount),
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
      return sig;
    },
  };
}

/** Minimal Base58 decode — avoids pulling in bs58 just for this. */
function decodeBase58(s: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) map.set(ALPHABET[i]!, i);

  let bytes: number[] = [0];
  for (const c of s) {
    const v = map.get(c);
    if (v === undefined) throw new Error(`Invalid base58 char: ${c}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of s) {
    if (c === "1") bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}
