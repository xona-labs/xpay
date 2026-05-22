/**
 * Direct USDC transfer — no x402, no provider, just send funds.
 *
 * Goes through the same guardrail as `use()` so a compromised CLI / agent
 * can't drain the wallet past the configured caps. v1 supports USDC only.
 */

import type { Network, PaymentRequirement } from "../types.js";
import type { Wallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";

/** Mint / contract addresses for the only token we support in v1. */
const USDC_ASSETS: Record<string, string> = {
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

export interface TransferArgs {
  /** Human amount (e.g. 5 means $5.00 USDC). */
  amount: number;
  /** Recipient address. Format implies the network unless overridden. */
  to: string;
  /** Force a specific network (required if the wallet has >1 EVM signer). */
  network?: Network;
  /** v1 only supports "USDC" — leaving it explicit for future-proofing. */
  token?: "USDC";
  wallet: Wallet;
  guardrail: Guardrail;
}

export interface TransferResult {
  network: Network;
  txSig: string;
  amount: number;
  token: "USDC";
  to: string;
}

export async function transfer(args: TransferArgs): Promise<TransferResult> {
  const token = (args.token ?? "USDC").toUpperCase();
  if (token !== "USDC") {
    throw new Error(`transfer: only USDC supported in v1 (got "${token}")`);
  }
  if (!(args.amount > 0)) {
    throw new Error(`transfer: amount must be > 0`);
  }

  const network = resolveNetwork(args);
  const asset = USDC_ASSETS[network];
  if (!asset) throw new Error(`transfer: no USDC address registered for "${network}"`);

  // USDC has 6 decimals on every chain we touch.
  const atoms = BigInt(Math.round(args.amount * 1_000_000)).toString();

  // Build a PaymentRequirement so the guardrail and signer code paths stay
  // identical to x402 `use()`. The guardrail's "resource" is synthetic — we
  // pretend the destination address is the host so allowedHosts can still gate
  // transfers (admin-only addresses, treasuries, etc).
  const requirement: PaymentRequirement = {
    asset,
    payTo: args.to,
    amount: atoms,
    scheme: "exact",
    network: networkToScheme(network),
  };

  await args.guardrail.check({
    resource: {
      resource: `xpay://transfer/${network}/${args.to}`,
      type: "transfer",
      method: "POST",
      accepts: [requirement],
    },
    requirement,
  });

  const signer = args.wallet.signer(network);
  const txSig = await signer.pay(requirement);

  return { network, txSig, amount: args.amount, token: "USDC", to: args.to };
}

/** Auto-detect the network from the address shape, with explicit override. */
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
  // Default to Solana.
  if (!args.wallet.has("solana")) {
    throw new Error(`transfer: address looks Solana but no Solana signer is configured`);
  }
  return "solana";
}

/** PayAI / x402 schemes use eip155 strings for EVM. Convert for consistency. */
function networkToScheme(net: Network): string {
  switch (net) {
    case "base": return "eip155:8453";
    case "ethereum": return "eip155:1";
    case "arbitrum": return "eip155:42161";
    case "optimism": return "eip155:10";
    default: return net;
  }
}
