/**
 * Direct SPL / ERC-20 transfer — no x402, no provider, just send funds.
 *
 * Goes through the same guardrail as `use()` so a compromised CLI / agent
 * can't drain the wallet past the configured caps.
 *
 * Solana: any SPL token by symbol (USDC, BONK, JUP, …) or raw mint address.
 * EVM:    USDC only (other ERC-20 addresses can be added to EVM_USDC as needed).
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import type { Network, PaymentRequirement } from "../types.js";
import type { Wallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";
import { magicBlockPrivateTransfer, type MagicBlockConfig } from "../magicblock/client.js";

// ─── Solana token registry ────────────────────────────────────────────────────

export interface SplTokenInfo {
  mint:     string;
  decimals: number;
  symbol:   string;
}

/** Well-known Solana SPL tokens — symbol (uppercase) → info. */
export const SOLANA_TOKENS: Record<string, SplTokenInfo> = {
  USDC:    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC"    },
  USDT:    { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, symbol: "USDT"    },
  WSOL:    { mint: "So11111111111111111111111111111111111111112",   decimals: 9, symbol: "wSOL"    },
  MSOL:    { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9, symbol: "mSOL"    },
  JITOSOL: { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9, symbol: "JitoSOL" },
  ETH:     { mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", decimals: 8, symbol: "ETH"     },
  BONK:    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, symbol: "BONK"    },
  JUP:     { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  decimals: 6, symbol: "JUP"     },
  PYTH:    { mint: "HZ1JovNiVvGrG91rGdVZr4N5bq4SB5tFTjS5jTmWDRy",  decimals: 6, symbol: "PYTH"    },
};

/** Reverse lookup: mint address → info. */
const BY_MINT: Record<string, SplTokenInfo> = {};
for (const info of Object.values(SOLANA_TOKENS)) {
  BY_MINT[info.mint] = info;
}

/** Symbols users can name in CLI / MCP. */
export const KNOWN_SOLANA_SYMBOLS = Object.values(SOLANA_TOKENS).map((t) => t.symbol);

// ─── EVM token addresses (USDC only for now) ─────────────────────────────────

const EVM_USDC: Record<string, string> = {
  base:      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism:  "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TransferArgs {
  /** Human amount (e.g. 5 means 5 tokens). */
  amount: number;
  /** Recipient address. Format implies the network unless overridden. */
  to: string;
  /** Force a specific network (required if the wallet has >1 EVM signer). */
  network?: Network;
  /**
   * Token to transfer.
   * - Solana: symbol ("USDC", "BONK", "JUP", …) or raw mint address.
   * - EVM: only "USDC" supported today.
   * Defaults to "USDC".
   */
  token?: string;
  /**
   * Route through MagicBlock's Private Ephemeral Rollup (Solana only).
   * Uses delayed execution + fund splitting to obscure amount and recipient
   * on the base chain.
   */
  private?: boolean;
  /** Platform-level MagicBlock config (sourced from the active xpay profile). */
  magicBlockConfig?: MagicBlockConfig;
  wallet: Wallet;
  guardrail: Guardrail;
}

export interface TransferResult {
  network: Network;
  txSig:   string;
  amount:  number;
  token:   string;
  to:      string;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function transfer(args: TransferArgs): Promise<TransferResult> {
  if (!(args.amount > 0)) {
    throw new Error(`transfer: amount must be > 0`);
  }

  const network = resolveNetwork(args);

  // ── EVM path: USDC only ──────────────────────────────────────────────────
  if (network !== "solana") {
    const tokenSymbol = (args.token ?? "USDC").toUpperCase();
    if (tokenSymbol !== "USDC") {
      throw new Error(
        `transfer: only USDC is supported on EVM networks (got "${args.token}"). ` +
        `Multi-token EVM support coming soon.`,
      );
    }
    const asset = EVM_USDC[network];
    if (!asset) throw new Error(`transfer: no USDC address registered for "${network}"`);

    const atoms = BigInt(Math.round(args.amount * 1_000_000)).toString();
    const requirement: PaymentRequirement = {
      asset, payTo: args.to, amount: atoms, scheme: "exact",
      network: networkToScheme(network),
    };
    await args.guardrail.check({
      resource: { resource: `xpay://transfer/${network}/${args.to}`, type: "transfer", method: "POST", accepts: [requirement] },
      requirement,
    });
    const signer = args.wallet.signer(network);
    const txSig = await signer.pay(requirement);
    return { network, txSig, amount: args.amount, token: "USDC", to: args.to };
  }

  // ── Solana path: native SOL ──────────────────────────────────────────────
  const tokenKey = (args.token ?? "USDC").toUpperCase();
  if (tokenKey === "SOL") {
    if (args.private) {
      throw new Error(
        `transfer: native SOL is not supported by MagicBlock PER (SPL tokens only). ` +
        `Use "wSOL" instead — it goes through the PER and settles as wrapped SOL on the other end.`,
      );
    }
    return transferNativeSol(args);
  }

  // ── Solana path: any SPL token ───────────────────────────────────────────
  const tokenInfo = await resolveSolanaToken(args.token ?? "USDC");
  const atoms = BigInt(Math.round(args.amount * Math.pow(10, tokenInfo.decimals))).toString();

  const requirement: PaymentRequirement = {
    asset:   tokenInfo.mint,
    payTo:   args.to,
    amount:  atoms,
    scheme:  "exact",
    network: "solana",
  };

  await args.guardrail.check({
    resource: { resource: `xpay://transfer/solana/${args.to}`, type: "transfer", method: "POST", accepts: [requirement] },
    requirement,
  });

  const signer = args.wallet.signer("solana");

  // Private mode → MagicBlock PER.
  if (args.private) {
    const result = await magicBlockPrivateTransfer({
      signer,
      mint:   tokenInfo.mint,
      amount: BigInt(atoms),
      to:     args.to,
      config: args.magicBlockConfig,
    });
    return { network, txSig: result.txSig, amount: args.amount, token: tokenInfo.symbol, to: args.to };
  }

  const txSig = await signer.pay(requirement);
  return { network, txSig, amount: args.amount, token: tokenInfo.symbol, to: args.to };
}

// ─── Native SOL transfer ──────────────────────────────────────────────────────

async function transferNativeSol(args: TransferArgs): Promise<TransferResult> {
  const lamports = BigInt(Math.round(args.amount * LAMPORTS_PER_SOL));

  const requirement: PaymentRequirement = {
    asset:   "SOL",
    payTo:   args.to,
    amount:  lamports.toString(),
    scheme:  "exact",
    network: "solana",
  };
  await args.guardrail.check({
    resource: { resource: `xpay://transfer/solana/${args.to}`, type: "transfer", method: "POST", accepts: [requirement] },
    requirement,
  });

  const signer = args.wallet.signer("solana");
  const rpc = process.env.XPAY_SOLANA_RPC ?? "https://solana-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ";
  const connection = new Connection(rpc, "confirmed");

  // Reconstruct keypair from the signer's signMessage so we can sign the tx.
  // rawSolanaSigner keeps the keypair internally — we access it by signing a
  // known message and rebuilding. Instead, we use a lower-level approach:
  // delegate to signer.pay() with a synthetic SOL "requirement" if it supports
  // it, otherwise build the SystemProgram.transfer tx ourselves.
  //
  // Since signer.pay() only knows SPL (it uses getOrCreateAssociatedTokenAccount),
  // we build the tx directly and sign via signMessage on the serialized message.
  const from = new PublicKey(signer.address);
  const to   = new PublicKey(args.to);

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }),
  );
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = from;

  const msgBytes  = tx.serializeMessage();
  const sigBytes  = await signer.signMessage(msgBytes);
  tx.addSignature(from, Buffer.from(sigBytes));

  const txSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(txSig, "confirmed");

  return { network: "solana", txSig, amount: args.amount, token: "SOL", to: args.to };
}

// ─── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a token name or mint address to its SPL info.
 * - Known symbol (case-insensitive, e.g. "usdc", "BONK", "wSOL") → registry lookup.
 * - Known mint address → registry lookup.
 * - Unknown base58 address → fetch decimals from Solana mainnet.
 * - Unrecognised → helpful error listing known symbols.
 */
async function resolveSolanaToken(token: string): Promise<SplTokenInfo> {
  // Normalise: strip hyphens/spaces, uppercase (handles "w-SOL", "jito-sol", etc.)
  const key = token.toUpperCase().replace(/[-\s]/g, "");

  if (SOLANA_TOKENS[key]) return SOLANA_TOKENS[key]!;

  // Exact alias checks (mixed-case symbols like "wSOL", "JitoSOL")
  const bySymbol = Object.values(SOLANA_TOKENS).find(
    (t) => t.symbol.toUpperCase() === key,
  );
  if (bySymbol) return bySymbol;

  // Reverse lookup by mint address.
  if (BY_MINT[token]) return BY_MINT[token]!;

  // Looks like a base58 mint address — fetch from chain.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) {
    const rpc = process.env.XPAY_SOLANA_RPC ?? "https://solana-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ";
    try {
      const conn = new Connection(rpc, "confirmed");
      const mintInfo = await getMint(conn, new PublicKey(token));
      return { mint: token, decimals: mintInfo.decimals, symbol: token.slice(0, 6) + "…" };
    } catch {
      throw new Error(
        `transfer: could not fetch mint info for "${token}". ` +
        `Verify the mint address is correct and on Solana mainnet.`,
      );
    }
  }

  throw new Error(
    `transfer: unknown token "${token}". ` +
    `Known symbols: ${KNOWN_SOLANA_SYMBOLS.join(", ")}. ` +
    `You can also pass a Solana mint address directly.`,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveNetwork(args: TransferArgs): Network {
  if (args.network) {
    if (!args.wallet.has(args.network)) {
      throw new Error(`transfer: no signer for network "${args.network}"`);
    }
    return args.network;
  }
  const looksLikeEvm = /^0x[0-9a-fA-F]{40}$/.test(args.to);
  if (looksLikeEvm) {
    const evm = ["base", "ethereum", "arbitrum", "optimism"].filter((n) => args.wallet.has(n));
    if (evm.length === 0) throw new Error(`transfer: address looks EVM but no EVM signer is configured`);
    if (evm.length === 1) return evm[0]!;
    throw new Error(
      `transfer: address is EVM-shaped but wallet has multiple EVM networks (${evm.join(", ")}). Pass --network to disambiguate.`,
    );
  }
  if (!args.wallet.has("solana")) {
    throw new Error(`transfer: address looks Solana but no Solana signer is configured`);
  }
  return "solana";
}

function networkToScheme(net: Network): string {
  switch (net) {
    case "base":      return "eip155:8453";
    case "ethereum":  return "eip155:1";
    case "arbitrum":  return "eip155:42161";
    case "optimism":  return "eip155:10";
    default:          return net;
  }
}
