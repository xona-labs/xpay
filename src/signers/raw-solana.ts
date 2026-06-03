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
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { TokenBalance } from "../types.js";

const KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC",    name: "USD Coin" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT",    name: "Tether USD" },
  "So11111111111111111111111111111111111111112":    { symbol: "wSOL",    name: "Wrapped SOL" },
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": { symbol: "mSOL",    name: "Marinade SOL" },
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": { symbol: "JitoSOL", name: "Jito Staked SOL" },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "ETH",     name: "Ether (Wormhole)" },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK",    name: "Bonk" },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":  { symbol: "JUP",     name: "Jupiter" },
  "HZ1JovNiVvGrG91rGdVZr4N5bq4SB5tFTjS5jTmWDRy":  { symbol: "PYTH",    name: "Pyth Network" },
};
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

    /**
     * Provide a `@solana/kit` TransactionSigner derived from our Keypair so
     * `useByUrl()` can use `@x402/svm` for canonical x402 SVM v2 payloads.
     */
    async getKitSigner(): Promise<unknown> {
      // Dynamic import — keeps @solana/signers off the hot path for users
      // who never call useByUrl against an SVM endpoint.
      const { createKeyPairSignerFromBytes } = await import("@solana/signers");
      return createKeyPairSignerFromBytes(keypair.secretKey);
    },

    async balance(): Promise<number> {
      try {
        const mint = new PublicKey(USDC_MINT_MAINNET);
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey);
        const acc = await getAccount(connection, ata);
        return Number(acc.amount) / 1_000_000;
      } catch {
        return 0;
      }
    },

    async tokenBalances(): Promise<TokenBalance[]> {
      const results: TokenBalance[] = [];

      // Native SOL
      try {
        const lamports = await connection.getBalance(keypair.publicKey);
        if (lamports > 0) {
          results.push({
            symbol: "SOL",
            name: "Solana",
            balance: lamports / 1e9,
            decimals: 9,
            isNative: true,
          });
        }
      } catch { /* skip */ }

      // All SPL token accounts
      try {
        const { value: accounts } = await connection.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { programId: TOKEN_PROGRAM_ID },
        );
        for (const { account } of accounts) {
          const parsed = account.data.parsed?.info;
          if (!parsed) continue;
          const mint: string = parsed.mint;
          const uiAmount: number = parsed.tokenAmount?.uiAmount ?? 0;
          const decimals: number = parsed.tokenAmount?.decimals ?? 0;
          if (uiAmount === 0) continue;
          const known = KNOWN_MINTS[mint];
          results.push({
            symbol: known?.symbol ?? mint.slice(0, 4) + "…",
            name: known?.name ?? "Unknown Token",
            balance: uiAmount,
            decimals,
            address: mint,
          });
        }
      } catch { /* skip */ }

      return results;
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
