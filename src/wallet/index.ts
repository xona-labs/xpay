/**
 * Multi-network wallet. Thin facade over per-network {@link Signer}s.
 *
 * The wallet doesn't hold keys — signers do. This module just exposes a
 * unified view (addresses, balances) and lets callers pick which network to
 * use for a given payment.
 */

import type { Network, PaymentRequirement, Signer } from "../types.js";

export interface WalletOptions {
  networks: Network[];
  signers: Partial<Record<Network, Signer>>;
}

export interface Wallet {
  /** Networks this wallet is configured for. */
  readonly networks: Network[];
  /** Get the address on a specific network. */
  address(network?: Network): string;
  /** Get the signer for a network, or throw if not configured. */
  signer(network: Network): Signer;
  /** True if a signer is configured for the network. */
  has(network: Network): boolean;
  /** USDC balance on a network in human units (e.g. 4.70). Returns 0 if unsupported. */
  balance(network?: Network): Promise<number>;
  /**
   * Pick the best network to satisfy one of the given payment requirements.
   * Strategy v0: first match where we have a signer + (eventually) enough balance.
   */
  pickRequirement(reqs: PaymentRequirement[]): PaymentRequirement | undefined;
}

export function createWallet(opts: WalletOptions): Wallet {
  const networks = opts.networks;
  const signers = opts.signers;

  function signer(network: Network): Signer {
    const s = signers[network];
    if (!s) throw new Error(`No signer configured for network "${network}"`);
    return s;
  }

  return {
    networks,
    address(network = networks[0]) {
      return signer(network).address;
    },
    signer,
    has: (network) => Boolean(signers[network]),
    async balance(network = networks[0]) {
      // v0: signers may expose a `balance()` method; fall back to 0 if not.
      const s = signers[network] as Signer & { balance?: () => Promise<number> } | undefined;
      if (!s) return 0;
      if (typeof s.balance === "function") return s.balance();
      return 0;
    },
    pickRequirement(reqs) {
      // Normalize EIP-155 strings ("eip155:8453") to our network slugs.
      const matchNetwork = (raw: string): Network | undefined => {
        if (signers[raw]) return raw;
        if (raw === "eip155:8453" && signers["base"]) return "base";
        if (raw === "eip155:1" && signers["ethereum"]) return "ethereum";
        if (raw === "eip155:42161" && signers["arbitrum"]) return "arbitrum";
        if (raw === "eip155:10" && signers["optimism"]) return "optimism";
        return undefined;
      };
      for (const req of reqs) {
        if (matchNetwork(req.network)) return req;
      }
      return undefined;
    },
  };
}
