/**
 * Gasless EVM stablecoin transfers (EIP-3009 `transferWithAuthorization`).
 *
 * The user's wallet signs an off-chain authorization for the exact amount and
 * recipient; a relayer wallet (funded with a little native gas by the platform)
 * submits it and pays the gas. The user's wallet needs zero ETH, which is what
 * makes "deposit USDC on Base, then send it out" work for wallets that only
 * ever received USDC.
 *
 * The relayer can't move anything the user didn't sign: the authorization
 * binds from, to, value, a validity window and a one-time nonce, and the token
 * contract checks the signature on-chain.
 */

import { Contract, JsonRpcProvider, Signature, Wallet } from "ethers";
import type { Network, Signer } from "../types.js";
import { evmChainId } from "../x402/evm-payment.js";

/** A signed EIP-3009 authorization, ready to submit on-chain. */
export interface TransferAuthorization {
  network: Network;
  /** Token contract (verifyingContract of the signature). */
  token: string;
  from: string;
  to: string;
  /** Atomic units, decimal string. */
  value: string;
  validAfter: string;
  validBefore: string;
  /** 0x-prefixed 32-byte hex. */
  nonce: string;
  /** 65-byte 0x signature from the payer. */
  signature: string;
}

/** Submits signed authorizations and pays their gas. */
export interface EvmRelayer {
  /** Networks this relayer can submit on. */
  supports(network: Network): boolean;
  /** EIP-712 domain of the token, read from chain (name + version). */
  domain(network: Network, token: string): Promise<{ name: string; version: string }>;
  /** Broadcast and wait for one confirmation. Resolves the tx hash. */
  submit(auth: TransferAuthorization): Promise<string>;
}

/**
 * The relayer can't pay right now (out of gas money). Thrown before anything
 * is broadcast, so the caller may safely fall back to the wallet paying its
 * own gas.
 */
export class RelayerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerUnavailableError";
  }
}

const EIP3009_ABI = [
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
];

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

export interface WalletEvmRelayerOptions {
  /** 0x hex private key of the gas-paying relayer wallet. */
  privateKey: string;
  /** RPC URL per network the relayer serves, e.g. `{ base: "https://..." }`. */
  rpcUrls: Partial<Record<Network, string>>;
}

/**
 * Relayer backed by a hot wallet holding native gas on each configured
 * network. Domain lookups are cached per token.
 */
export function walletEvmRelayer(opts: WalletEvmRelayerOptions): EvmRelayer {
  const wallets = new Map<string, Wallet>();
  for (const [network, url] of Object.entries(opts.rpcUrls)) {
    if (!url) continue;
    const provider = new JsonRpcProvider(url, evmChainId(network), { staticNetwork: true });
    wallets.set(network, new Wallet(opts.privateKey, provider));
  }
  const domains = new Map<string, Promise<{ name: string; version: string }>>();

  function walletFor(network: Network): Wallet {
    const w = wallets.get(network);
    if (!w) throw new Error(`evm relayer: not configured for network "${network}"`);
    return w;
  }

  return {
    supports: (network) => wallets.has(network),

    domain(network, token) {
      const key = `${network}:${token.toLowerCase()}`;
      let hit = domains.get(key);
      if (!hit) {
        const c = new Contract(token, EIP3009_ABI, walletFor(network));
        hit = Promise.all([c.name!() as Promise<string>, c.version!() as Promise<string>])
          .then(([name, version]) => ({ name, version }));
        // Don't cache a failed lookup (RPC blip).
        hit.catch(() => domains.delete(key));
        domains.set(key, hit);
      }
      return hit;
    },

    async submit(auth) {
      const wallet = walletFor(auth.network);
      const c = new Contract(auth.token, EIP3009_ABI, wallet);
      const sig = Signature.from(auth.signature);
      const args = [
        auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter),
        BigInt(auth.validBefore), auth.nonce, sig.v, sig.r, sig.s,
      ] as const;
      // Simulate first: a bad signature or short balance fails here, before
      // the relayer spends gas on a reverting transaction.
      try {
        await c.transferWithAuthorization!.staticCall(...args);
      } catch (e) {
        throw new Error(`transfer: ${revertReason(e)}`);
      }
      let tx;
      try {
        tx = await c.transferWithAuthorization!(...args);
      } catch (e) {
        if ((e as { code?: string }).code === "INSUFFICIENT_FUNDS") {
          throw new RelayerUnavailableError(`transfer: gas sponsor (${wallet.address}) is out of funds on ${auth.network}`);
        }
        throw e;
      }
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`transfer: relayed transaction ${tx.hash} reverted`);
      }
      return receipt.hash;
    },
  };
}

function revertReason(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; message?: string };
  const reason = err.reason ?? err.shortMessage ?? err.message ?? String(e);
  // FiatToken reverts with "ERC20: transfer amount exceeds balance".
  if (/exceeds balance/i.test(reason)) return "insufficient USDC balance for this transfer";
  return reason;
}

/**
 * Sign an EIP-3009 authorization with the payer's signer and have the relayer
 * submit it. Caller has already run the guardrail.
 */
export async function relayedTransfer(args: {
  relayer: EvmRelayer;
  signer: Signer;
  network: Network;
  token: string;
  to: string;
  /** Atomic units. */
  value: string;
  /** Seconds the authorization stays valid. Default 10 minutes. */
  ttlSeconds?: number;
}): Promise<string> {
  if (!args.signer.signEvmTypedData) {
    throw new Error("transfer: this wallet's signer can't sign gasless transfers");
  }
  const { name, version } = await args.relayer.domain(args.network, args.token);
  const now = Math.floor(Date.now() / 1000);
  const nonce = "0x" + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const auth: TransferAuthorization = {
    network: args.network,
    token: args.token,
    from: args.signer.address,
    to: args.to,
    value: args.value,
    validAfter: String(now - 600), // absorbs clock skew
    validBefore: String(now + (args.ttlSeconds ?? 600)),
    nonce,
    signature: "",
  };
  auth.signature = await args.signer.signEvmTypedData({
    domain: { name, version, chainId: evmChainId(args.network), verifyingContract: args.token },
    types: AUTHORIZATION_TYPES,
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  return args.relayer.submit(auth);
}
