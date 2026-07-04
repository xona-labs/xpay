/**
 * AgenC hire execution — the non-x402 payment rail.
 *
 * Hiring a listing is a Solana transaction (program
 * HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK) that escrows the listing's
 * price in native SOL and creates a Task + HireRecord on-chain. The provider
 * then works ASYNCHRONOUSLY: escrow → work → review → settle. So unlike an
 * x402 call, `use()` on an AgenC resource returns a hire *receipt*, not a
 * response body — poll progress with `xpay agenc status <taskPda>`.
 *
 * The humanless entry point pins the task to CreatorReview, so escrowed funds
 * never auto-release without the buyer accepting the result.
 */

import type { PaymentRequirement, UseResult } from "../types.js";
import { chargePlatformFee, type UseArgs } from "../use/index.js";
import { DEFAULT_RPC } from "../signers/raw-solana.js";
import { AGENC_SCHEME, fetchAgencListing } from "./api.js";

export interface AgencHireConfig {
  /** Solana RPC for building/sending the hire tx. Falls back to XPAY_SOLANA_RPC, then xpay's default. */
  rpcUrl?: string;
  /** Buyer review window after the provider submits, in seconds. Default 86400 (24h). */
  reviewWindowSecs?: number;
  /** AgenC API base override (freshness check + status polling). */
  endpoint?: string;
}

/** Returned as `UseResult.data` for an AgenC hire. */
export interface AgencHireReceipt {
  kind: "agenc-hire-receipt";
  /** Listing PDA that was hired. */
  listing: string;
  /** Task PDA created by the hire — the handle for status polling and review. */
  task: string;
  /** HireRecord PDA linking the task back to the listing. */
  hireRecord: string;
  providerAgent: string;
  priceLamports: string;
  txSig: string;
  status: "escrowed";
  statusHint: string;
  explorer: string;
}

interface AgencExtra {
  listingPda: string;
  specHash: string;
  version: string;
}

export async function useAgencHire(args: UseArgs): Promise<UseResult> {
  const req = args.resource.accepts.find((a) => a.scheme === AGENC_SCHEME);
  if (!req) {
    throw new Error("xpay.agenc: resource has no agenc-hire payment option");
  }
  const extra = parseExtra(req);
  const cfg = args.agenc ?? {};

  // Guardrail runs *before* signing — same security boundary as the x402 path.
  await args.guardrail.check({ resource: args.resource, requirement: req });

  // Freshness check: the catalog snapshot may be stale — refuse if the listing
  // was paused/retired or repriced upward since discovery. The on-chain
  // expectedPrice/expectedVersion checks are the fail-closed backstop.
  const live = await fetchAgencListing(extra.listingPda, { endpoint: cfg.endpoint });
  if (!live) {
    throw new Error(
      `xpay.agenc: listing ${extra.listingPda} is no longer hireable (paused, retired, ` +
        `at capacity, or failed moderation). Re-run discover for current listings.`,
    );
  }
  if (BigInt(live.priceLamports) > BigInt(req.amount ?? "0")) {
    throw new Error(
      `xpay.agenc: listing ${extra.listingPda} price rose from ${req.amount} to ` +
        `${live.priceLamports} lamports since discovery. Re-run discover and retry.`,
    );
  }

  const signer = args.wallet.signer("solana");
  if (typeof signer.getKitSigner !== "function") {
    throw new Error(
      "xpay.agenc: hiring needs a Solana signer with getKitSigner() (the built-in " +
        "rawSolanaSigner provides one). Custom signers must implement it for AgenC hires.",
    );
  }
  const kitSigner = (await signer.getKitSigner()) as import("@solana/kit").TransactionSigner;

  const rpcUrl = cfg.rpcUrl ?? process.env.XPAY_SOLANA_RPC ?? DEFAULT_RPC;

  // Pre-flight: the hire escrows priceLamports in NATIVE SOL (plus fees/rent),
  // so check the SOL balance — the USDC insufficient-balance path doesn't apply.
  const { createSolanaRpc, address } = await import("@solana/kit");
  const rpc = createSolanaRpc(rpcUrl);
  const FEE_BUFFER_LAMPORTS = 10_000_000n; // ~0.01 SOL for fees + PDA rent
  const needed = BigInt(live.priceLamports) + FEE_BUFFER_LAMPORTS;
  const { value: lamports } = await rpc.getBalance(address(signer.address)).send();
  if (BigInt(lamports) < needed) {
    throw new Error(
      `xpay.agenc: insufficient SOL — hire needs ~${fmtSol(needed)} SOL ` +
        `(${fmtSol(BigInt(live.priceLamports))} escrow + fees) but ${signer.address} ` +
        `holds ${fmtSol(BigInt(lamports))} SOL. Fund the wallet and retry.`,
    );
  }

  const {
    createMarketplaceClient,
    findTaskPda,
    findHireRecordPda,
    getListingModerationDecoder,
    AGENC_COORDINATION_PROGRAM_ADDRESS,
  } = await import("@tetsuo-ai/marketplace-sdk");

  // Resolve the listing's moderation attestation. The deployed mainnet
  // program seeds it as ["listing_moderation", listing, specHash] (no
  // moderator in the seeds), and the record itself names the moderator the
  // hire gate expects — so both are discoverable without extra config. The
  // SDK facade would derive the newer v2 seeds by default, which the deployed
  // program rejects (InvalidModerationRecord), so pass both explicitly.
  const { getProgramDerivedAddress, getAddressEncoder, getUtf8Encoder } = await import(
    "@solana/kit"
  );
  const [listingModeration] = await getProgramDerivedAddress({
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("listing_moderation"),
      getAddressEncoder().encode(address(extra.listingPda)),
      hexToBytes(extra.specHash),
    ],
  });
  const modInfo = await rpc.getAccountInfo(listingModeration, { encoding: "base64" }).send();
  if (!modInfo.value) {
    throw new Error(
      `xpay.agenc: listing ${extra.listingPda} has no on-chain moderation attestation — ` +
        `the hire gate is fail-closed, so it cannot be hired yet. Re-run discover later.`,
    );
  }
  const modRecord = getListingModerationDecoder().decode(
    Uint8Array.from(Buffer.from(String(modInfo.value.data[0]), "base64")),
  );

  const client = createMarketplaceClient({ rpcUrl, signer: kitSigner });

  const taskId = crypto.getRandomValues(new Uint8Array(32));
  const { signature } = await client.hireFromListingHumanless({
    listing: address(extra.listingPda),
    creator: kitSigner,
    taskId,
    expectedPrice: BigInt(live.priceLamports),
    expectedVersion: BigInt(extra.version),
    reviewWindowSecs: BigInt(cfg.reviewWindowSecs ?? 86_400),
    listingSpecHash: hexToBytes(extra.specHash),
    moderator: modRecord.moderator,
    listingModeration,
  });

  const [taskPda] = await findTaskPda({ creator: kitSigner.address, taskId });
  const [hireRecordPda] = await findHireRecordPda({ task: taskPda });

  const receipt: AgencHireReceipt = {
    kind: "agenc-hire-receipt",
    listing: extra.listingPda,
    task: taskPda,
    hireRecord: hireRecordPda,
    providerAgent: String(req.extra?.providerAgent ?? ""),
    priceLamports: live.priceLamports,
    txSig: signature,
    status: "escrowed",
    statusHint:
      "SOL is escrowed on-chain; the provider works asynchronously. Poll progress with " +
      `\`xpay agenc status ${taskPda}\` — funds settle to the provider after your review window.`,
    explorer: `https://solscan.io/tx/${signature}`,
  };

  const result: UseResult = {
    data: receipt,
    // Synthetic: there is no HTTP response for an on-chain hire. 200 keeps the
    // UseResult contract ("non-ok would have thrown") for downstream consumers.
    status: 200,
    network: "solana",
    amountPaid: live.priceLamports,
    txSig: signature,
  };
  result.platformFee = await chargePlatformFee(args.wallet);
  return result;
}

function parseExtra(req: PaymentRequirement): AgencExtra {
  const extra = req.extra ?? {};
  const listingPda = extra.listingPda;
  const specHash = extra.specHash;
  const version = extra.version;
  if (
    typeof listingPda !== "string" ||
    typeof specHash !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error(
      "xpay.agenc: malformed AgenC resource — missing listingPda/specHash/version in " +
        "accepts[].extra. Re-run discover to get a fresh listing.",
    );
  }
  return { listingPda, specHash, version };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("xpay.agenc: specHash must be a 32-byte hex string");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fmtSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(4);
}
