/**
 * Build the canonical x402 EVM v2 `X-Payment` header value (gasless).
 *
 * Spec flow (`exact` scheme on eip155 networks):
 *   client signs an EIP-3009 `TransferWithAuthorization` typed-data payload
 *   (an off-chain signature — USDC supports it natively) → header carries
 *   the authorization + signature → facilitator submits the transfer
 *   on-chain and pays the gas.
 *
 * The payer wallet therefore needs ZERO native ETH: this replaces the legacy
 * `signer.pay()` path, which broadcast a plain `erc20.transfer()` from the
 * wallet and failed with "insufficient funds for intrinsic transaction cost"
 * on gasless agent wallets.
 *
 * Payload shape mirrors `@x402/evm`'s `exact` client scheme, which is what
 * `ExactEvmScheme` servers + facilitators (PayAI, CDP) verify against.
 */

import type { PaymentRequirement } from "../types.js";

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

/** Chain ids for the named networks xpay profiles use. */
const NAMED_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
};

export interface BuildEvmPaymentArgs {
  /** Payer address (the EVM signer's wallet address). */
  address: string;
  /** EIP-712 typed-data signer — from `signer.signEvmTypedData`. */
  signTypedData: (typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, unknown>;
  }) => Promise<string>;
  /** What the server's 402 told us we owe. */
  requirement: PaymentRequirement;
  /** x402 protocol version for the envelope. Defaults to 2. */
  x402Version?: number;
}

export function evmChainId(network: string): number {
  if (network.startsWith("eip155:")) {
    const id = Number(network.slice("eip155:".length));
    if (Number.isInteger(id) && id > 0) return id;
    throw new Error(`buildEvmPaymentHeader: bad eip155 network "${network}"`);
  }
  const id = NAMED_CHAIN_IDS[network];
  if (!id) throw new Error(`buildEvmPaymentHeader: unknown EVM network "${network}"`);
  return id;
}

/** True for networks paid via the EVM x402 path (eip155 CAIP ids or named EVM chains). */
export function isEvmNetwork(network: string): boolean {
  return network.startsWith("eip155:") || network in NAMED_CHAIN_IDS;
}

/**
 * True when this requirement carries the EIP-712 domain params (`extra.name`
 * + `extra.version`) the gasless signature needs. Catalog snapshots usually
 * strip `extra` — a fresh 402 challenge always has it.
 */
export function hasEvmDomainParams(req: PaymentRequirement): boolean {
  return Boolean(req.extra?.name && req.extra?.version);
}

/**
 * Returns the value of the `X-Payment` header (base64 of canonical JSON
 * envelope), ready to attach to the retry request. Nothing is broadcast —
 * the facilitator settles server-side.
 */
export async function buildEvmPaymentHeader(args: BuildEvmPaymentArgs): Promise<string> {
  const req = args.requirement;
  // The EIP-3009 payload shape only exists in x402 v2 — never emit a v1
  // envelope here (v1 catalog entries without a version reach us as 1).
  const version = Math.max(args.x402Version ?? 2, 2);

  if (!hasEvmDomainParams(req)) {
    throw new Error(
      `buildEvmPaymentHeader: EIP-712 domain params (extra.name/extra.version) missing for asset ${req.asset} — re-fetch the live 402 challenge`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const nonce = "0x" + Buffer.from(nonceBytes).toString("hex");

  // Authorization values travel as decimal strings in the header payload but
  // are signed as uint256 — same split @x402/evm's client makes.
  const authorization = {
    from: args.address,
    to: req.payTo,
    value: req.amount ?? "0",
    validAfter: String(now - 600), // small back-date absorbs clock skew
    validBefore: String(now + (req.maxTimeoutSeconds ?? 300)),
    nonce,
  };

  const signature = await args.signTypedData({
    domain: {
      name: String(req.extra!.name),
      version: String(req.extra!.version),
      chainId: evmChainId(req.network),
      verifyingContract: req.asset,
    },
    types: AUTHORIZATION_TYPES,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  // Full canonical PaymentPayloadV2 envelope, same assembly as the SVM
  // builder: `accepted` echoes which of the server's accepts[] we picked.
  const envelope = {
    x402Version: version,
    accepted: {
      payTo: req.payTo,
      amount: req.amount ?? "0",
      asset: req.asset,
      network: req.network,
      scheme: req.scheme || "exact",
      maxTimeoutSeconds: req.maxTimeoutSeconds ?? 300,
      extra: req.extra ?? undefined,
    },
    payload: { signature, authorization },
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}
