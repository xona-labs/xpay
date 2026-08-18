/**
 * MPP tempo/charge credential: a signed (not broadcast) Tempo transaction
 * carrying a TIP-20 `transferWithMemo` to the recipient - the MPP "pull"
 * mode. The server broadcasts it, and when the challenge advertises
 * `methodDetails.feePayer: true` it also sponsors the network fee, so the
 * payer wallet needs only the stablecoin itself.
 *
 * Tempo transactions are not plain EVM type-2 txs - they use expiring
 * nonces (`nonceKey: "expiring"` + `validBefore`) and optional fee-payer
 * sponsorship - so this module signs with viem's tempo extensions rather
 * than ethers. Flow mirrors mppx's tempo client, verified end-to-end
 * against mpp.dev's paid ping endpoint on Moderato.
 *
 * The transfer memo is the MPP attribution encoding (32 bytes:
 * tag|version|serverId|clientId|nonce) whose trailing 7 bytes are
 * keccak256(challengeId) - binding the on-chain transfer to the challenge
 * so a settlement tx can't be replayed against a different challenge.
 */

import { createClient, http, keccak256, toBytes, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareTransactionRequest, signTransaction } from "viem/actions";
import { Actions } from "viem/tempo";
import { tempo, tempoModerato, tempoTestnet, tempoDevnet } from "viem/tempo/chains";
import type { MppChallenge } from "./challenge.js";

/** Tempo chains by id - mainnet plus testnets (Moderato is what mpp.dev uses). */
const TEMPO_CHAINS: Record<number, Chain> = Object.fromEntries(
  [tempo, tempoModerato, tempoTestnet, tempoDevnet].map((c) => [c.id, c]),
);

/** Tempo mainnet chain id - the one the "tempo" network slug settles on. */
export const TEMPO_MAINNET_CHAIN_ID = tempo.id;

export interface BuildMppTempoChargeArgs {
  /** 0x-prefixed EVM private key (Tempo uses secp256k1 accounts). */
  privateKey: string;
  challenge: MppChallenge;
}

export interface MppTempoCharge {
  /** Credential `payload` - the signed pull-mode transaction. */
  payload: Record<string, unknown>;
  /** Credential `source` - payer identity in did:pkh form. */
  source: string;
}

export async function buildMppTempoCharge(args: BuildMppTempoChargeArgs): Promise<MppTempoCharge> {
  const ch = args.challenge;
  const r = ch.request as {
    amount?: string;
    currency: Hex;
    recipient: Hex;
    methodDetails?: { chainId?: number; feePayer?: boolean; memo?: Hex; supportedModes?: string[] };
  };
  const chainId = r.methodDetails?.chainId ?? TEMPO_MAINNET_CHAIN_ID;
  const chain = TEMPO_CHAINS[chainId];
  if (!chain) {
    throw new Error(`mpp tempo-charge: unknown Tempo chain id ${chainId}`);
  }
  const modes = r.methodDetails?.supportedModes;
  if (Array.isArray(modes) && !modes.includes("pull")) {
    throw new Error(
      `mpp tempo-charge: challenge only supports [${modes.join(", ")}] - xpay signs pull-mode credentials`,
    );
  }

  const account = privateKeyToAccount(args.privateKey as Hex);
  const client = createClient({ account, chain, transport: http() });

  const memo = r.methodDetails?.memo ?? attributionMemo(ch.id, ch.realm);
  const transferCall = Actions.token.transfer.call(client, {
    amount: BigInt(r.amount ?? "0"),
    memo,
    to: r.recipient,
    token: r.currency,
  });

  // Sign against the earlier of the challenge expiry and a short local
  // window - the server settles immediately, so a tight validBefore just
  // limits how long a leaked credential stays broadcastable.
  const now = Math.floor(Date.now() / 1000);
  const validBefore = ch.expires
    ? Math.min(now + 25, Math.floor(Date.parse(ch.expires) / 1000))
    : now + 25;

  const prepared = (await prepareTransactionRequest(client, {
    account,
    calls: [transferCall],
    nonceKey: "expiring",
    validBefore,
  } as never)) as Record<string, unknown>;
  // Headroom for sender-signature + access-key verification costs the
  // estimate misses (same pad as mppx's client).
  prepared.gas = ((prepared.gas as bigint | undefined) ?? 0n) + 5000n;
  if (r.methodDetails?.feePayer) {
    delete prepared.feePayerSignature;
    delete prepared.feeToken;
    prepared.feePayer = true;
  }

  const signature = await signTransaction(client, prepared as never);

  return {
    payload: { signature, type: "transaction" },
    source: `did:pkh:eip155:${chainId}:${account.address}`,
  };
}

/**
 * MPP attribution memo (32 bytes) for TIP-20 transferWithMemo:
 *
 *   0..3   keccak256("mpp")[0..3]        tag
 *   4      0x01                          version
 *   5..14  keccak256(realm)[0..9]        serverId
 *   15..24 zero bytes                    clientId (anonymous)
 *   25..31 keccak256(challengeId)[0..6]  challenge-binding nonce
 */
function attributionMemo(challengeId: string, realm: string): Hex {
  const buf = new Uint8Array(32);
  const fp = (s: string, n: number) => toBytes(keccak256(toBytes(s))).slice(0, n);
  buf.set(fp("mpp", 4), 0);
  buf[4] = 0x01;
  buf.set(fp(realm, 10), 5);
  buf.set(fp(challengeId, 7), 25);
  return `0x${Buffer.from(buf).toString("hex")}` as Hex;
}
