/**
 * SIWX free tier - sign in with the wallet instead of paying.
 *
 * Some x402 servers advertise a `sign-in-with-x` (CAIP-122) challenge in the
 * 402 body's `extensions`, granting free access to wallets that prove
 * identity - e.g. Xona's $XONA holder tier, where holding the token earns
 * free daily generations. The flow costs nothing to attempt: sign the
 * challenge, retry with the SIGN-IN-WITH-X header, and fall back to a normal
 * paid settlement if the server declines (not enough tokens, quota used, ...).
 *
 * Only Solana (ed25519) challenges are attempted here: the paid routes that
 * offer this perk today are Solana-gated, and the Solana signer's raw
 * `signMessage` is exactly the primitive SIWS needs.
 */

import type { Wallet } from "../wallet/index.js";

/** The `sign-in-with-x` info block served in a 402 body's extensions. */
interface SiwxInfo {
  domain: string;
  uri: string;
  version: string;
  nonce: string;
  issuedAt: string;
  statement?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export interface SiwxFreeChallenge {
  info: SiwxInfo;
  /** Full CAIP-2 chain id, e.g. `solana:5eykt4UsFv8P...` */
  chainId: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Pull a Solana SIWX challenge out of a 402 body, if the server offers one.
 * Returns null when the extension is absent or only offered on chains we
 * don't sign SIWS for.
 */
export function extractSiwxFreeChallenge(data: unknown): SiwxFreeChallenge | null {
  if (!isObj(data) || !isObj(data.extensions)) return null;
  const ext = data.extensions["sign-in-with-x"];
  if (!isObj(ext) || !isObj(ext.info)) return null;

  const info = ext.info as unknown as SiwxInfo;
  if (!info.domain || !info.uri || !info.nonce || !info.issuedAt) return null;

  const chains = Array.isArray(ext.supportedChains) ? ext.supportedChains : [];
  const solana = chains.find(
    (c): c is { chainId: string } =>
      isObj(c) && typeof c.chainId === "string" && c.chainId.startsWith("solana:"),
  );
  if (!solana) return null;

  return { info, chainId: solana.chainId };
}

/** Build the SIWS (CAIP-122) message text the server verifies against. */
function buildSiwsMessage(challenge: SiwxFreeChallenge, address: string): string {
  const { info, chainId } = challenge;
  const chainRef = chainId.split(":")[1] ?? chainId;
  const lines = [`${info.domain} wants you to sign in with your Solana account:`, address, ""];
  if (info.statement) lines.push(info.statement, "");
  lines.push(
    `URI: ${info.uri}`,
    `Version: ${info.version || "1"}`,
    `Chain ID: ${chainRef}`,
    `Nonce: ${info.nonce}`,
    `Issued At: ${info.issuedAt}`,
  );
  if (info.expirationTime) lines.push(`Expiration Time: ${info.expirationTime}`);
  if (info.notBefore) lines.push(`Not Before: ${info.notBefore}`);
  if (info.requestId) lines.push(`Request ID: ${info.requestId}`);
  if (info.resources && info.resources.length > 0) {
    lines.push("Resources:");
    for (const r of info.resources) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

/**
 * Sign the challenge with the wallet's Solana signer and return the value for
 * the SIGN-IN-WITH-X header (base64 JSON payload, base58 ed25519 signature).
 * Returns null when the wallet has no Solana signer to sign with.
 */
export async function buildSiwxFreeHeader(
  wallet: Wallet,
  challenge: SiwxFreeChallenge,
): Promise<string | null> {
  if (!wallet.has("solana")) return null;
  const signer = wallet.signer("solana");

  // Bind the challenge to the host that issued it - a proxied or replayed
  // challenge for another domain must not be signed.
  const message = buildSiwsMessage(challenge, signer.address);
  const sigBytes = await signer.signMessage(new TextEncoder().encode(message));

  const payload = {
    domain: challenge.info.domain,
    address: signer.address,
    statement: challenge.info.statement,
    uri: challenge.info.uri,
    version: challenge.info.version || "1",
    chainId: challenge.chainId,
    type: "ed25519",
    nonce: challenge.info.nonce,
    issuedAt: challenge.info.issuedAt,
    expirationTime: challenge.info.expirationTime,
    notBefore: challenge.info.notBefore,
    requestId: challenge.info.requestId,
    resources: challenge.info.resources,
    signature: encodeBase58(sigBytes),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Header the free-tier server echoes the remaining daily quota on. */
export const SIWX_FREE_REMAINING_HEADER = "x-xona-holder-free-remaining";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal Base58 encode - avoids pulling in bs58 just for one signature. */
function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}
