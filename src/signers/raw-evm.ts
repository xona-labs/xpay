/**
 * Raw EVM signer — works for Base, Ethereum, Arbitrum, Optimism, and other
 * EIP-155 chains. Holds a hex private key via `ethers.Wallet`.
 */

import { Contract, JsonRpcProvider, Wallet, getBytes, hashMessage } from "ethers";
import type { Network, PaymentRequirement, Signer } from "../types.js";

/** Per-network USDC contract addresses. */
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

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
];

export interface RawEvmSignerOptions {
  /** 0x-prefixed hex private key. */
  privateKey: string;
  /** Target network. Required so we know which RPC + chainId to use. */
  network: Network;
  /** Override the default RPC URL. */
  rpcUrl?: string;
}

export function rawEvmSigner(opts: RawEvmSignerOptions): Signer {
  const rpc = opts.rpcUrl ?? DEFAULT_RPCS[opts.network];
  if (!rpc) {
    throw new Error(`rawEvmSigner: no default RPC for network "${opts.network}". Pass rpcUrl.`);
  }
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(opts.privateKey, provider);

  return {
    network: opts.network,
    address: wallet.address,

    async signMessage(message) {
      const sig = await wallet.signMessage(getBytes(hashMessage(message)));
      return getBytes(sig);
    },

    async balance(): Promise<number> {
      const usdc = USDC_CONTRACTS[opts.network];
      if (!usdc) return 0;
      try {
        const erc20 = new Contract(usdc, ERC20_ABI, provider);
        const raw = (await erc20.balanceOf!(wallet.address)) as bigint;
        // USDC has 6 decimals on every supported chain.
        return Number(raw) / 1_000_000;
      } catch {
        return 0;
      }
    },

    async pay(req: PaymentRequirement): Promise<string> {
      // Native ETH transfer (asset is the zero address).
      if (req.asset === "0x0000000000000000000000000000000000000000") {
        const tx = await wallet.sendTransaction({
          to: req.payTo,
          value: BigInt(req.amount ?? "0"),
        });
        const receipt = await tx.wait();
        return receipt?.hash ?? tx.hash;
      }

      // ERC-20 transfer.
      const erc20 = new Contract(req.asset, ERC20_ABI, wallet);
      const tx = await erc20.transfer!(req.payTo, BigInt(req.amount ?? "0"));
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  };
}
