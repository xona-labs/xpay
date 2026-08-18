/**
 * Raw EVM signer - works for Base, Ethereum, Arbitrum, Optimism, and other
 * EIP-155 chains. Holds a hex private key via `ethers.Wallet`.
 */

import { Contract, JsonRpcProvider, Wallet, getBytes, hashMessage } from "ethers";
import type { Network, PaymentRequirement, Signer, TokenBalance } from "../types.js";

const NATIVE_TOKEN: Record<string, { symbol: string; name: string }> = {
  base:     { symbol: "ETH", name: "Ether" },
  ethereum: { symbol: "ETH", name: "Ether" },
  arbitrum: { symbol: "ETH", name: "Ether" },
  optimism: { symbol: "ETH", name: "Ether" },
  robinhood: { symbol: "ETH", name: "Ether" },
  // Stable's gas coin is USDT itself, at 18 decimals - the ERC-20 USDT0 below
  // is a different token with 6 decimals. Distinct symbols keep them apart in
  // the balance view.
  stable: { symbol: "USDT", name: "Tether USD (gas)" },
  // Tempo (Stripe/Paradigm payments L1, chain 4217) has no native gas token -
  // fees are paid in TIP-20 stablecoins - so no NATIVE_TOKEN entry either.
};

const KNOWN_ERC20S: Record<string, Array<{ symbol: string; name: string; contract: string; decimals: number }>> = {
  base: [
    { symbol: "USDC", name: "USD Coin",       contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    { symbol: "USDT", name: "Tether USD",     contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    { symbol: "WETH", name: "Wrapped Ether",  contract: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "DAI",  name: "Dai",            contract: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
    { symbol: "cbBTC",name: "Coinbase BTC",   contract: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  ],
  ethereum: [
    { symbol: "USDC", name: "USD Coin",       contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { symbol: "USDT", name: "Tether USD",     contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { symbol: "WETH", name: "Wrapped Ether",  contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    { symbol: "DAI",  name: "Dai",            contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  ],
  arbitrum: [
    { symbol: "USDC", name: "USD Coin",       contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { symbol: "USDT", name: "Tether USD",     contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    { symbol: "WETH", name: "Wrapped Ether",  contract: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
  ],
  optimism: [
    { symbol: "USDC", name: "USD Coin",       contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    { symbol: "USDT", name: "Tether USD",     contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
    { symbol: "WETH", name: "Wrapped Ether",  contract: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "OP",   name: "Optimism",       contract: "0x4200000000000000000000000000000000000042", decimals: 18 },
  ],
  // Robinhood Chain (Arbitrum Orbit L2, chain 4663) is ETH-native; no canonical
  // USDC exists there yet, so no USDC entry - `balance()` reports 0 by design.
  robinhood: [
    { symbol: "WETH", name: "Wrapped Ether",  contract: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18 },
  ],
  // Stable (chain 988). USDT0 is the LayerZero OFT that x402 settles in - 6
  // decimals as an ERC-20, verified on-chain via decimals()/symbol().
  stable: [
    { symbol: "USDT0", name: "USDT0", contract: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
  ],
  // Tempo (chain 4217). USDC.e is the bridged Circle USDC as a TIP-20 - it
  // answers the standard ERC-20 read surface (symbol/decimals/balanceOf
  // verified on-chain), so balances work over plain JSON-RPC.
  tempo: [
    { symbol: "USDC.e", name: "USD Coin (Tempo)", contract: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6 },
  ],
};

/**
 * The stablecoin x402 settles in on each network - what `balance()` reports and
 * what payment routing compares a price against. USDC everywhere except Stable,
 * which settles USDT0. All are 6 decimals, so the `/ 1_000_000` below holds.
 */
const SETTLEMENT_STABLECOIN: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  stable: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  tempo: "0x20C000000000000000000000b9537d11c60E8b50",
};

const DEFAULT_RPCS: Record<string, string> = {
  base: "https://base-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ",
  ethereum: "https://eth-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ",
  arbitrum: "https://arb-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ",
  optimism: "https://opt-mainnet.g.alchemy.com/v2/Ug5mqBVIbSHoa8ZHgTUSJ",
  robinhood: "https://rpc.mainnet.chain.robinhood.com",
  stable: "https://rpc.stable.xyz",
  tempo: "https://rpc.tempo.xyz",
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

    // EIP-712 signing for gasless x402 v2 (EIP-3009 transferWithAuthorization).
    async signEvmTypedData({ domain, types, message }) {
      return wallet.signTypedData(domain, types, message);
    },

    // Underlying ethers Wallet (provider-connected) for on-chain DEX trades.
    getEvmWallet() {
      return wallet;
    },

    async balance(): Promise<number> {
      const asset = SETTLEMENT_STABLECOIN[opts.network];
      if (!asset) return 0;
      try {
        const erc20 = new Contract(asset, ERC20_ABI, provider);
        const raw = (await erc20.balanceOf!(wallet.address)) as bigint;
        return Number(raw) / 1_000_000;
      } catch {
        return 0;
      }
    },

    async tokenBalances(): Promise<TokenBalance[]> {
      const results: TokenBalance[] = [];

      // Native gas token (ETH, etc.)
      const native = NATIVE_TOKEN[opts.network];
      if (native) {
        try {
          const raw = await provider.getBalance(wallet.address);
          const bal = Number(raw) / 1e18;
          if (bal > 0) {
            results.push({ ...native, balance: bal, decimals: 18, isNative: true });
          }
        } catch { /* skip */ }
      }

      // Known ERC-20s
      const tokens = KNOWN_ERC20S[opts.network] ?? [];
      await Promise.all(tokens.map(async (t) => {
        try {
          const erc20 = new Contract(t.contract, ERC20_ABI, provider);
          const raw = (await erc20.balanceOf!(wallet.address)) as bigint;
          const bal = Number(raw) / Math.pow(10, t.decimals);
          if (bal > 0) {
            results.push({ symbol: t.symbol, name: t.name, balance: bal, decimals: t.decimals, address: t.contract });
          }
        } catch { /* skip */ }
      }));

      return results;
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
