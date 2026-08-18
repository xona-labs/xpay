/**
 * Build the MPP `Authorization: Payment <base64url JSON>` credential and read
 * back the `Payment-Receipt` header.
 *
 * Credential wire shape (mirrors mppx's Credential.serialize):
 *
 *   {
 *     "challenge": { id, realm, method, intent,
 *                    request: "<raw base64url from the 402>",
 *                    expires?, digest?, description?, opaque? },
 *     "payload":   { ...method-specific proof... },
 *     "source":    "did:pkh:eip155:8453:0x..."   // payer identity, optional
 *   }
 *
 * The challenge fields (and especially the raw `request` / `opaque` strings)
 * must round-trip byte-identical: the server recomputes the HMAC-bound `id`
 * over them and rejects the credential on any drift.
 */

import type { MppChallenge } from "./challenge.js";

export interface BuildCredentialArgs {
  challenge: MppChallenge;
  /** Method-specific proof, e.g. the signed EIP-3009 authorization. */
  payload: Record<string, unknown>;
  /** Payer identity (did:pkh form). */
  source?: string;
}

/** Serialize a credential to the `Authorization` header value. */
export function buildMppAuthorizationHeader(args: BuildCredentialArgs): string {
  const c = args.challenge;
  const wire = {
    challenge: {
      id: c.id,
      realm: c.realm,
      method: c.method,
      intent: c.intent,
      request: c.requestRaw,
      ...(c.description !== undefined && { description: c.description }),
      ...(c.digest !== undefined && { digest: c.digest }),
      ...(c.expires !== undefined && { expires: c.expires }),
      ...(c.opaque !== undefined && { opaque: c.opaque }),
    },
    payload: args.payload,
    ...(args.source && { source: args.source }),
  };
  const encoded = Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
  return `Payment ${encoded}`;
}

/**
 * Settlement receipt from the `Payment-Receipt` response header.
 * `reference` is the method-specific settlement handle - for on-chain
 * methods, the transaction hash.
 */
export interface MppReceipt {
  method: string;
  reference: string;
  /** Always "success" on the happy path - failures come back as 402 + Problem Details. */
  status: string;
  /** RFC 3339 settlement timestamp. */
  timestamp?: string;
  [key: string]: unknown;
}

/** Decode the Payment-Receipt header. undefined when absent or unparseable. */
export function extractMppReceipt(headers: Headers): MppReceipt | undefined {
  const raw = headers.get("payment-receipt");
  if (!raw) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof (decoded as MppReceipt).reference === "string"
    ) {
      return decoded as MppReceipt;
    }
  } catch {
    /* tolerate junk headers */
  }
  return undefined;
}
