/**
 * Unified history — merges Solana + EVM USDC activity into a single sorted feed.
 */

import type { Network } from "../types.js";
import type { Wallet } from "../wallet/index.js";
import { fetchSolanaHistory } from "./solana.js";
import { fetchEvmHistory } from "./evm.js";
import type { HistoryEntry } from "./types.js";

export * from "./types.js";

export interface HistoryOptions {
  /** Restrict to specific networks. Defaults to all the wallet supports. */
  networks?: Network[];
  /** Max entries to return (after merge + sort). */
  limit?: number;
  /** Per-network block window for EVM scans. */
  evmBlockWindow?: number;
  /** Per-network RPC overrides. */
  rpcs?: Partial<Record<Network, string>>;
}

const EVM_NETWORKS: Network[] = ["base", "ethereum", "arbitrum", "optimism"];

export async function getHistory(
  wallet: Wallet,
  opts: HistoryOptions = {},
): Promise<HistoryEntry[]> {
  const networks = opts.networks ?? wallet.networks;
  const perNetwork = Math.max(opts.limit ?? 25, 25);

  const results = await Promise.all(
    networks.map(async (net) => {
      if (!wallet.has(net)) return [];
      const address = wallet.address(net);
      try {
        if (net === "solana") {
          return await fetchSolanaHistory({
            address,
            limit: perNetwork,
            rpcUrl: opts.rpcs?.solana,
          });
        }
        if (EVM_NETWORKS.includes(net)) {
          return await fetchEvmHistory({
            address,
            network: net,
            limit: perNetwork,
            blockWindow: opts.evmBlockWindow,
            rpcUrl: opts.rpcs?.[net],
          });
        }
      } catch (err) {
        // One bad network shouldn't kill history. Log and continue.
        // eslint-disable-next-line no-console
        console.warn(`[xpay] history fetch failed for ${net}:`, (err as Error).message);
      }
      return [];
    }),
  );

  const merged = results.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  if (opts.limit) return merged.slice(0, opts.limit);
  return merged;
}
