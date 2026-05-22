/**
 * EVM USDC history via ERC-20 Transfer event logs.
 *
 * Strategy: scan a recent block window for `Transfer` events on the USDC
 * contract where `from` or `to` is the wallet. Public RPCs typically allow a
 * window of ~5k–10k blocks per `eth_getLogs` call; we paginate if needed.
 *
 * Good enough for the v1 history view. For production / large windows, swap
 * the RPC for an indexer (Basescan/Alchemy/Covalent) by passing `rpcUrl`.
 */

import { Contract, JsonRpcProvider, ZeroAddress, hexlify, toBeHex, zeroPadValue } from "ethers";
import type { HistoryEntry } from "./types.js";
import type { Network } from "../types.js";

const USDC_CONTRACTS: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

const DEFAULT_RPCS: Record<string, string> = {
  base: "https://mainnet.base.org",
  ethereum: "https://eth.llamarpc.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
};

/** Window (in blocks) scanned for transfer history. ~2 days at 2s block times. */
const DEFAULT_BLOCK_WINDOW = 100_000;
/** Public RPCs commonly cap getLogs at 10k blocks. Stay under it. */
const MAX_LOG_RANGE = 9_500;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface EvmHistoryOptions {
  address: string;
  network: Network;
  limit?: number;
  blockWindow?: number;
  rpcUrl?: string;
}

const TRANSFER_IFACE = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

export async function fetchEvmHistory(opts: EvmHistoryOptions): Promise<HistoryEntry[]> {
  const usdc = USDC_CONTRACTS[opts.network];
  const rpc = opts.rpcUrl ?? DEFAULT_RPCS[opts.network];
  if (!usdc || !rpc) {
    throw new Error(`fetchEvmHistory: no USDC contract / RPC for network "${opts.network}"`);
  }

  const provider = new JsonRpcProvider(rpc);
  const latest = await provider.getBlockNumber();
  const from = Math.max(0, latest - (opts.blockWindow ?? DEFAULT_BLOCK_WINDOW));

  const padded = zeroPadValue(opts.address, 32);

  type LogList = Awaited<ReturnType<typeof provider.getLogs>>;
  /** Chunked getLogs — public RPCs cap range, so we walk backwards in MAX_LOG_RANGE
   *  windows and stop early once we have enough hits for the requested limit. */
  async function chunkedLogs(topics: (string | null)[]): Promise<LogList> {
    const all: LogList = [];
    let end = latest;
    while (end > from) {
      const start = Math.max(from, end - MAX_LOG_RANGE);
      try {
        const batch = await provider.getLogs({
          address: usdc,
          topics,
          fromBlock: start,
          toBlock: end,
        });
        all.push(...batch);
      } catch (err) {
        // Tolerate per-chunk failures (rate limits) — keep what we have.
        // eslint-disable-next-line no-console
        console.warn(`[xpay] evm history chunk ${start}-${end} failed:`, (err as Error).message);
      }
      if (opts.limit && all.length >= opts.limit) break;
      end = start - 1;
    }
    return all;
  }

  const [outgoing, incoming] = await Promise.all([
    chunkedLogs([TRANSFER_TOPIC, padded, null]),
    chunkedLogs([TRANSFER_TOPIC, null, padded]),
  ]);

  const erc20 = new Contract(usdc, TRANSFER_IFACE, provider);
  const logs = [...outgoing, ...incoming];
  const seen = new Set<string>();

  // Pull block timestamps for each unique block in the result.
  const blockNumbers = [...new Set(logs.map((l) => l.blockNumber))];
  const blocks = new Map<number, number>();
  await Promise.all(
    blockNumbers.map(async (bn) => {
      try {
        const b = await provider.getBlock(bn);
        if (b?.timestamp) blocks.set(bn, b.timestamp * 1000);
      } catch {
        /* skip */
      }
    }),
  );

  const out: HistoryEntry[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.index}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const parsed = erc20.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) continue;
    const fromAddr = (parsed.args[0] as string).toLowerCase();
    const toAddr = (parsed.args[1] as string).toLowerCase();
    const value = parsed.args[2] as bigint;

    const isSend = fromAddr === opts.address.toLowerCase();
    out.push({
      timestamp: blocks.get(log.blockNumber) ?? null,
      network: opts.network,
      signature: log.transactionHash,
      direction: isSend ? "send" : "receive",
      counterparty: isSend ? toAddr : fromAddr,
      amountUsdc: Number(value) / 1_000_000,
    });
  }

  out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  if (opts.limit) return out.slice(0, opts.limit);
  return out;
}

// hint to tree-shakers: keep this import live (used in JSDoc only otherwise)
void hexlify;
void toBeHex;
void ZeroAddress;
