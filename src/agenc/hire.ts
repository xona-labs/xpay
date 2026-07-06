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
  /** On-chain program surface revision at hire time (observability for AgenC upgrades). */
  surfaceRevision?: number;
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

  const sdk = await import("@tetsuo-ai/marketplace-sdk");
  const { createMarketplaceClient, findTaskPda, findHireRecordPda } = sdk;

  // Surface guard: AgenC upgrades its on-chain program frequently (surface
  // revisions are stamped in ProtocolConfig). Refuse clearly when the
  // deployed program doesn't expose the listings/hire family, instead of
  // failing deep inside a transaction.
  const surface = await deployedSurface(sdk, rpc);
  if (!surface.listings) {
    throw new Error(
      `xpay.agenc: the deployed AgenC program (surface revision ${surface.surfaceRevision}) ` +
        `does not expose listings/hires on this cluster. xpay may need an update — check ` +
        `for a newer @xona-labs/xpay release.`,
    );
  }

  // Resolve the listing's moderation attestation. The record's on-chain
  // ADDRESS has changed seed schemes across program upgrades, but its CONTENT
  // always names the moderator the hire gate expects — so we locate the
  // record (trying each known derivation, newest data wins) and pass both
  // the moderator and the explicit record address to the facade. Fail-closed
  // BEFORE the guardrail/payment path if no attestation exists.
  const moderation = await resolveListingModeration(sdk, rpc, extra.listingPda, extra.specHash);
  if (!moderation) {
    throw new Error(
      `xpay.agenc: listing ${extra.listingPda} has no on-chain moderation attestation yet ` +
        `(AgenC re-attests listings after program upgrades). The hire gate is fail-closed — ` +
        `pick another listing or retry later.`,
    );
  }

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
    moderator: address(moderation.moderator),
    listingModeration: address(moderation.address),
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
    surfaceRevision: surface.surfaceRevision,
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

// ─── Program-upgrade resilience helpers ──────────────────────────────────────

type AgencSdk = typeof import("@tetsuo-ai/marketplace-sdk");

/* Minimal structural view of the kit RPC — keeps these helpers decoupled from
 * kit's branded generics while accepting the client hire() already builds. */
interface MinimalRpc {
  getAccountInfo(
    addr: unknown,
    opts: unknown,
  ): { send(): Promise<{ value: { data: unknown[] } | null }> };
  getProgramAccounts(
    program: unknown,
    opts: unknown,
  ): { send(): Promise<ReadonlyArray<{ pubkey: string; account: { data: unknown[] } }>> };
}

let surfaceCache: { value: { surfaceRevision: number; listings: boolean }; at: number } | undefined;

/** Deployed instruction surface, cached 10 min — one account fetch. */
async function deployedSurface(sdk: AgencSdk, rpc: unknown) {
  if (surfaceCache && Date.now() - surfaceCache.at < 600_000) return surfaceCache.value;
  const value = await sdk.getDeployedSurface(rpc as Parameters<AgencSdk["getDeployedSurface"]>[0]);
  surfaceCache = { value, at: Date.now() };
  return value;
}

interface ResolvedModeration {
  address: string;
  moderator: string;
}

/**
 * Locate the listing's moderation attestation record. The seed scheme has
 * changed across AgenC program upgrades, so try each known derivation, then a
 * seed-agnostic scan:
 *   1. v1 seeds ["listing_moderation", listing, specHash]
 *   2. v2 seeds ["listing_moderation_v2", listing, specHash, globalAuthority]
 *   3. getProgramAccounts scan (discriminator + listing memcmp)
 * Whatever record is found, its CONTENT names the moderator the hire gate
 * expects — return both so the facade can skip its own derivation.
 */
export async function resolveListingModeration(
  sdk: AgencSdk,
  rpc: unknown,
  listingPda: string,
  specHashHex: string,
): Promise<ResolvedModeration | null> {
  const { getProgramDerivedAddress, getAddressEncoder, getUtf8Encoder, getBase58Decoder, address } =
    await import("@solana/kit");
  const specHash = hexToBytes(specHashHex);

  const candidates: string[] = [];

  // 1) v1 seeds — pre-upgrade attestations (still honored by the program).
  const [v1] = await getProgramDerivedAddress({
    programAddress: sdk.AGENC_COORDINATION_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("listing_moderation"),
      getAddressEncoder().encode(address(listingPda)),
      specHash,
    ],
  });
  candidates.push(v1);

  // 2) v2 seeds authored by the platform's global moderation authority.
  try {
    const [mcPda] = await sdk.findModerationConfigPda();
    const mc = await sdk.fetchMaybeModerationConfig(
      rpc as Parameters<AgencSdk["fetchMaybeModerationConfig"]>[0],
      mcPda,
    );
    if (mc.exists) {
      const [v2] = await sdk.findListingModerationPda({
        listing: address(listingPda),
        jobSpecHash: specHash,
        moderator: address(mc.data.moderationAuthority),
      });
      candidates.push(v2);
    }
  } catch {
    /* moderation config unreadable — continue with what we have */
  }

  for (const candidate of candidates) {
    const found = await tryDecodeModeration(sdk, rpc as MinimalRpc, candidate);
    if (found) return found;
  }

  // 3) Seed-agnostic: scan the program's moderation records for this listing.
  //    Best effort — some RPCs rate-limit or forbid getProgramAccounts.
  try {
    const disc = getBase58Decoder().decode(sdk.LISTING_MODERATION_DISCRIMINATOR);
    const rows = await (rpc as MinimalRpc)
      .getProgramAccounts(sdk.AGENC_COORDINATION_PROGRAM_ADDRESS, {
        encoding: "base64",
        filters: [
          { memcmp: { offset: 0n, bytes: disc, encoding: "base58" } },
          { memcmp: { offset: 8n, bytes: listingPda, encoding: "base58" } },
        ],
      })
      .send();
    for (const row of rows) {
      const rec = decodeModeration(sdk, row.account.data);
      if (rec) return { address: row.pubkey, moderator: rec };
    }
  } catch {
    /* scan unavailable — fall through to fail-closed */
  }

  return null;
}

async function tryDecodeModeration(
  sdk: AgencSdk,
  rpc: MinimalRpc,
  pda: string,
): Promise<ResolvedModeration | null> {
  const info = await rpc.getAccountInfo(pda, { encoding: "base64" }).send();
  if (!info.value) return null;
  const moderator = decodeModeration(sdk, info.value.data);
  return moderator ? { address: pda, moderator } : null;
}

function decodeModeration(sdk: AgencSdk, data: unknown[]): string | null {
  try {
    const record = sdk
      .getListingModerationDecoder()
      .decode(Uint8Array.from(Buffer.from(String(data[0]), "base64")));
    return String(record.moderator);
  } catch {
    return null;
  }
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
