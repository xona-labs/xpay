/**
 * Solana USDC history via standard JSON-RPC.
 *
 * Strategy:
 *   1. `getSignaturesForAddress` on the wallet's USDC associated token account
 *      (ATA), not the wallet itself — token-program txs are addressed to the
 *      ATA, not the owner.
 *   2. `getParsedTransactions` (batched) to extract amounts + counterparties.
 *
 * Works on free public RPC for small `limit` values. For prod scale, drop in
 * a Helius / Triton RPC via the `rpcUrl` arg.
 */

import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import type { HistoryEntry } from "./types.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export interface SolanaHistoryOptions {
  address: string;
  limit?: number;
  rpcUrl?: string;
}

export async function fetchSolanaHistory(opts: SolanaHistoryOptions): Promise<HistoryEntry[]> {
  const limit = Math.min(opts.limit ?? 25, 1000);
  const connection = new Connection(opts.rpcUrl ?? DEFAULT_RPC, "confirmed");

  const owner = new PublicKey(opts.address);
  const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), owner);

  const sigs = await connection.getSignaturesForAddress(ata, { limit });
  if (sigs.length === 0) return [];

  // Batch-fetch parsed txs (RPC supports up to ~100 per batch via single calls,
  // but the helper here just fires Promise.all on individual calls — public RPC
  // tolerates this at small limits).
  const parsed = await Promise.all(
    sigs.map((s) =>
      connection
        .getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
        .catch(() => null),
    ),
  );

  const out: HistoryEntry[] = [];
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i]!;
    const tx = parsed[i];
    const entry = extractTransferEntry(tx, sig.signature, opts.address);
    if (!entry) continue;
    entry.timestamp = sig.blockTime ? sig.blockTime * 1000 : null;
    entry.status = sig.err ? "failed" : sig.confirmationStatus ?? "confirmed";
    out.push(entry);
  }
  return out;
}

function extractTransferEntry(
  tx: ParsedTransactionWithMeta | null,
  signature: string,
  ownerAddress: string,
): HistoryEntry | null {
  if (!tx?.meta || tx.meta.err) {
    // Still emit failed tx so users can see them.
    return tx
      ? {
          timestamp: null,
          network: "solana",
          signature,
          direction: "send",
          counterparty: "",
          amountUsdc: 0,
        }
      : null;
  }

  for (const ix of tx.transaction.message.instructions) {
    const parsed = ix as ParsedInstruction;
    if (parsed.program !== "spl-token") continue;
    const info = parsed.parsed?.info as
      | {
          authority?: string;
          source?: string;
          destination?: string;
          tokenAmount?: { amount: string; decimals: number };
          amount?: string;
        }
      | undefined;
    if (!info) continue;

    const type = parsed.parsed?.type as string | undefined;
    if (type !== "transfer" && type !== "transferChecked") continue;

    // For SPL transfers we need to map source/dest token accounts back to owners.
    // The pre/post token balances expose this cleanly.
    const owners = (tx.meta.postTokenBalances ?? []).reduce<Record<number, string>>((acc, b) => {
      if (b.owner) acc[b.accountIndex] = b.owner;
      return acc;
    }, {});

    const sourceIdx = tx.transaction.message.accountKeys.findIndex(
      (k) => k.pubkey.toBase58() === info.source,
    );
    const destIdx = tx.transaction.message.accountKeys.findIndex(
      (k) => k.pubkey.toBase58() === info.destination,
    );
    const sourceOwner = sourceIdx >= 0 ? owners[sourceIdx] ?? info.source : info.source;
    const destOwner = destIdx >= 0 ? owners[destIdx] ?? info.destination : info.destination;

    const isSend = info.authority === ownerAddress || sourceOwner === ownerAddress;
    const isReceive = destOwner === ownerAddress;
    if (!isSend && !isReceive) continue;

    const rawAmount = info.tokenAmount?.amount ?? info.amount ?? "0";
    const decimals = info.tokenAmount?.decimals ?? 6;
    const amount = Number(rawAmount) / 10 ** decimals;

    return {
      timestamp: null, // filled in by caller
      network: "solana",
      signature,
      direction: isSend ? "send" : "receive",
      counterparty: isSend ? destOwner ?? "" : sourceOwner ?? "",
      amountUsdc: amount,
    };
  }
  return null;
}
