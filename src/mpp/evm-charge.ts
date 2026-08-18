/**
 * MPP evm/charge credential payload: a signed EIP-3009
 * `TransferWithAuthorization` - the same gasless primitive our x402 v2 EVM
 * path uses, with two MPP-specific twists (mirroring mppx's evm client):
 *
 *   nonce       = keccak256(utf8(challenge.id + challenge.realm))
 *                 - binds the signature to this exact challenge, and makes
 *                   replays collide on-chain (EIP-3009 nonces are single-use)
 *   validBefore = challenge.expires (epoch secs), falling back to now+300
 *
 * The EIP-712 domain name/version are NOT in the challenge - MPP assumes the
 * client knows its tokens. We resolve them from a registry of known EIP-3009
 * stablecoins on the chains xpay ships signers for.
 */

import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import type { MppChallenge } from "./challenge.js";

/** EIP-712 types for EIP-3009 transferWithAuthorization. */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/**
 * Known EIP-3009 token domains, keyed `<chainId>:<lowercase contract>`.
 * USDC's domain name differs between mainnets ("USD Coin") and Base Sepolia
 * ("USDC") - values match Circle's deployed contracts and mppx's registry.
 */
const EIP3009_DOMAINS: Record<string, { name: string; version: string }> = {
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USD Coin", version: "2" }, // USDC Base
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { name: "USD Coin", version: "2" }, // USDC Ethereum
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831": { name: "USD Coin", version: "2" }, // USDC Arbitrum
  "10:0x0b2c639c533813f4aa9d7837caf62653d097ff85": { name: "USD Coin", version: "2" }, // USDC Optimism
  "84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e": { name: "USDC", version: "2" }, // USDC Base Sepolia
};

export interface BuildMppEvmAuthorizationArgs {
  /** Payer address (the EVM signer's wallet address). */
  address: string;
  /** EIP-712 typed-data signer - from `signer.signEvmTypedData`. */
  signTypedData: (typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, unknown>;
  }) => Promise<string>;
  challenge: MppChallenge;
}

export interface MppEvmAuthorization {
  /** Credential `payload` - the signed authorization. */
  payload: Record<string, unknown>;
  /** Credential `source` - payer identity in did:pkh form. */
  source: string;
}

export async function buildMppEvmAuthorization(
  args: BuildMppEvmAuthorizationArgs,
): Promise<MppEvmAuthorization> {
  const ch = args.challenge;
  const r = ch.request as {
    amount?: string;
    currency: string;
    recipient: string;
    methodDetails?: { chainId?: number; authorization?: { name?: string; version?: string } };
  };
  const chainId = r.methodDetails?.chainId;
  if (!chainId) throw new Error("mpp evm-charge: challenge request is missing methodDetails.chainId");

  const currency = getAddress(r.currency);
  const domainParams = resolveDomain(chainId, currency, r.methodDetails);
  const from = getAddress(args.address);
  const to = getAddress(r.recipient);
  const value = r.amount ?? "0";
  const nonce = keccak256(toUtf8Bytes(`${ch.id}${ch.realm}`));
  const validBefore = ch.expires
    ? String(Math.floor(Date.parse(ch.expires) / 1000))
    : String(Math.floor(Date.now() / 1000) + 300);

  const signature = await args.signTypedData({
    domain: {
      name: domainParams.name,
      version: domainParams.version,
      chainId,
      verifyingContract: currency,
    },
    types: AUTHORIZATION_TYPES,
    message: {
      from,
      to,
      value: BigInt(value),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  return {
    payload: {
      type: "authorization",
      from,
      to,
      value,
      validAfter: "0",
      validBefore,
      nonce,
      signature,
    },
    source: `did:pkh:eip155:${chainId}:${from}`,
  };
}

function resolveDomain(
  chainId: number,
  currency: string,
  details: { authorization?: { name?: string; version?: string } } | undefined,
): { name: string; version: string } {
  // Some servers volunteer the domain params in methodDetails - trust them.
  const inline = details?.authorization;
  if (inline?.name && inline?.version) return { name: inline.name, version: inline.version };

  const known = EIP3009_DOMAINS[`${chainId}:${currency.toLowerCase()}`];
  if (known) return known;

  throw new Error(
    `mpp evm-charge: unknown EIP-3009 domain for token ${currency} on eip155:${chainId} - ` +
      `cannot sign transferWithAuthorization without the token's EIP-712 name/version`,
  );
}
