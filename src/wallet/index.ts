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
   * Strategy v0: first match where we have a signer (ignores balance).
   */
  pickRequirement(reqs: PaymentRequirement[]): PaymentRequirement | undefined;
  /**
   * Balance-aware picker. Among requirements we have a signer for, prefer the
   * first (in listed order) whose wallet balance covers the cost — so a $0
   * Base wallet falls through to a funded Solana one. When there are multiple
   * payable networks but none can cover the cost, returns `undefined` so the
   * caller can raise a clear "insufficient balance" error instead of attempting
   * a doomed payment. A single payable option is returned as-is (the payment
   * flow handles funding the normal way).
   */
  pickRequirementByBalance(reqs: PaymentRequirement[]): Promise<PaymentRequirement | undefined>;
}

export function createWallet(opts: WalletOptions): Wallet {
  const networks = opts.networks;
  const signers = opts.signers;

  function signer(network: Network): Signer {
    const s = signers[network];
    if (!s) throw new Error(`No signer configured for network "${network}"`);
    return s;
  }

  /** Normalize an EIP-155 / Solana-CAIP network string to a configured slug. */
  function matchNetwork(raw: string): Network | undefined {
    if (signers[raw]) return raw;
    // Solana CAIP — `solana:<genesis-hash>` (mainnet/devnet/testnet) → "solana".
    if ((raw === "solana" || raw.startsWith("solana:") || raw.startsWith("solana-")) && signers["solana"]) {
      return "solana";
    }
    if (raw === "eip155:8453" && signers["base"]) return "base";
    if (raw === "eip155:1" && signers["ethereum"]) return "ethereum";
    if (raw === "eip155:42161" && signers["arbitrum"]) return "arbitrum";
    if (raw === "eip155:10" && signers["optimism"]) return "optimism";
    if (raw === "eip155:4663" && signers["robinhood"]) return "robinhood";
    return undefined;
  }

  /** USDC balance for a network slug; 0 when the signer can't report it. */
  async function balanceOf(network: Network): Promise<number> {
    const s = signers[network] as (Signer & { balance?: () => Promise<number> }) | undefined;
    if (!s || typeof s.balance !== "function") return 0;
    try {
      return await s.balance();
    } catch {
      return 0;
    }
  }

  return {
    networks,
    address(network = networks[0]) {
      return signer(network).address;
    },
    signer,
    has: (network) => Boolean(signers[network]),
    balance: (network = networks[0]) => balanceOf(network),
    pickRequirement(reqs) {
      for (const req of reqs) {
        if (matchNetwork(req.network)) return req;
      }
      return undefined;
    },
    async pickRequirementByBalance(reqs) {
      // Keep only options we can actually sign for, preserving listed order.
      const candidates = reqs.filter((r) => matchNetwork(r.network));
      // 0 → no signer; 1 → the only option, leave funding to the payment flow.
      if (candidates.length <= 1) return candidates[0];

      // Multiple payable networks: read each balance in parallel and pick the
      // first (listed order) that covers the cost. Compare assumes USDC
      // (6 decimals) — the asset for virtually all x402 calls.
      const scored = await Promise.all(
        candidates.map(async (req) => {
          const net = matchNetwork(req.network)!;
          const bal = await balanceOf(net);
          const need = req.amount ? Number(req.amount) / 1_000_000 : 0;
          return { req, bal, need };
        }),
      );

      // First that can cover the cost; undefined when none can (caller errors).
      return scored.find((c) => c.bal >= c.need)?.req;
    },
  };
}
