/**
 * @xona-labs/xpay — discovery + usage layer for agentic commerce.
 *
 * Quick start:
 * ```ts
 * import { createXPay, rawSolanaSigner } from "@xona-labs/xpay";
 *
 * const xpay = createXPay({
 *   networks: ["solana", "base"],
 *   signers: { solana: rawSolanaSigner(SECRET_KEY) },
 * });
 *
 * const results = await xpay.discover({ query: "weather forecast" });
 * const result  = await xpay.use(results[0]);
 * ```
 */

import { createWallet, type Wallet, type WalletOptions } from "./wallet/index.js";
import { discover } from "./discover/index.js";
import { use, useByUrl } from "./use/index.js";
import { doIt } from "./do/index.js";
import { Guardrail, type GuardrailConfig } from "./guardrail/index.js";
import { signersFromProfile, deriveKeysFromMnemonic, type LoadedProfile } from "./profile/index.js";
import { fetchReport, type WalletReport, type ReportOptions } from "./report/index.js";
import { transfer, type TransferResult } from "./transfer/index.js";
import { findTokens, type TokenInfo } from "./token/index.js";
import { swap, swapQuote, type SwapQuote, type SwapResult } from "./swap/index.js";
import { trade, tradeQuote, type TradeQuote, type TradeResult } from "./trading/index.js";
import { trendingTokens, newTokens, type DiscoveredToken } from "./trading/discovery.js";
import type {
  DiscoverOptions,
  Resource,
  UseResult,
  Network,
  Signer,
} from "./types.js";

export * from "./types.js";
export * from "./signers/index.js";
export * from "./tools/index.js";
export * from "./profile/index.js";
export * from "./report/index.js";
export * from "./transfer/index.js";
export { Guardrail } from "./guardrail/index.js";
/**
 * Direct access to the discovery layer for callers (e.g. server routes) that
 * want catalog data without configuring signers.
 */
export { discover } from "./discover/index.js";
export { fetchPayAIResources } from "./discover/payai.js";
export { fetchOrbitX402Resources } from "./discover/orbitx402.js";
export {
  fetchAgencResources,
  fetchAgencListing,
  fetchAgencTask,
  listingToResource,
  isAgencResource,
  AGENC_SCHEME,
} from "./agenc/api.js";
export type { AgencHireConfig, AgencHireReceipt } from "./agenc/hire.js";
export {
  findTokens,
  resolveTradeToken,
  enrichTokenBalances,
  AmbiguousTokenError,
  NATIVE_SOL_MINT,
  type TokenInfo,
  type TokenApiOptions,
  type EnrichedTokenBalance,
} from "./token/index.js";
export {
  swap as swapTokens,
  swapQuote as quoteSwap,
  type SwapArgs,
  type SwapConfig,
  type SwapQuote,
  type SwapResult,
} from "./swap/index.js";
export {
  trade as tradeTokens,
  tradeQuote as quoteTrade,
  RH_CONTRACTS,
  type TradeArgs,
  type TradeConfig,
  type TradeQuote,
  type TradeResult,
  type TradeTokenInfo,
} from "./trading/index.js";
export {
  trendingTokens,
  newTokens,
  tokenPriceUsd,
  robinhoodHoldings,
  type DiscoveredToken,
  type TokenHolding,
} from "./trading/discovery.js";

/** Options for {@link createXPay}. */
export interface XPayOptions {
  /**
   * A loaded profile — derives `networks`, `signers`, and `guardrail` from
   * the profile's keyfile and config. Mutually exclusive with the manual
   * `networks` + `signers` shape below.
   */
  profile?: LoadedProfile;
  /** Networks the wallet will track. First entry is the default for payments. */
  networks?: Network[];
  /** Signers keyed by network. At minimum, one signer must be provided. */
  signers?: Partial<Record<Network, Signer>>;
  /** Optional spending guardrail enforced before every {@link XPay.use} call. */
  guardrail?: GuardrailConfig;
  /** Override the OrbitX402 discovery endpoint (for self-hosted instances / tests). */
  discoveryEndpoint?: string;
}

/** The xPay client returned by {@link createXPay}. */
export interface XPay {
  wallet: Wallet;
  guardrail: Guardrail;
  /** Find paid services across configured catalogs. */
  discover(opts?: DiscoverOptions): Promise<Resource[]>;
  /** Call a specific resource — handles payment + retry. */
  use(resource: Resource, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<UseResult>;
  /**
   * Call any URL that supports x402 — even one not in the catalog. Probes the
   * URL, follows the 402 challenge, settles, retries.
   */
  useByUrl(url: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<UseResult>;
  /** Search by intent, pick the top result, and call it. The thesis in one method. */
  do(query: string, opts?: { body?: unknown }): Promise<UseResult>;
  /** Comprehensive USDC activity report (daily / weekly / monthly) via OrbitX402. */
  report(opts?: ReportOptions): Promise<WalletReport>;
  /**
   * Direct token transfer (no x402). Subject to the same guardrail.
   * Solana: USDC, USDT, wSOL, BONK, JUP, PYTH, or any mint address.
   * EVM: USDC only.
   * Pass private:true for MagicBlock PER privacy (Solana only).
   */
  transfer(args: { amount: number; to: string; network?: Network; token?: string; private?: boolean }): Promise<TransferResult>;
  /** Search Solana tokens by ticker, name, or mint (Jupiter). Read-only, no signing. */
  findTokens(query: string, opts?: { limit?: number }): Promise<TokenInfo[]>;
  /** Quote a swap without executing — no guardrail, no signing, no funds moved. */
  swapQuote(args: { amount: number; from: string; to: string; slippageBps?: number }): Promise<SwapQuote>;
  /** Swap tokens inside the wallet (Solana only, Jupiter). Subject to the guardrail. */
  swap(args: { amount: number; from: string; to: string; slippageBps?: number }): Promise<SwapResult>;
  /**
   * Quote a Robinhood Chain trade without executing — no guardrail, no signing.
   * `from`/`to` are "ETH" or an ERC-20 address / trending symbol (one must be ETH).
   */
  tradeQuote(args: { amount: number; from: string; to: string; slippageBps?: number }): Promise<TradeQuote>;
  /**
   * Trade tokens on Robinhood Chain via Uniswap V3 (NOXA Fun launchpad).
   * Buy a token with native ETH or sell it back to ETH. Subject to the guardrail.
   */
  trade(args: { amount: number; from: string; to: string; slippageBps?: number }): Promise<TradeResult>;
  /** Tokens from pools trending on Robinhood Chain right now (GeckoTerminal). Read-only. */
  trendingTokens(opts?: { limit?: number }): Promise<DiscoveredToken[]>;
  /** Tokens from the newest Robinhood Chain pools (fresh, high-risk launches). Read-only. */
  newTokens(opts?: { limit?: number }): Promise<DiscoveredToken[]>;
}

/**
 * Create an xPay client.
 *
 * This is the single entry point for builders. Everything else is exposed for
 * advanced cases (custom signers, manual discovery, raw x402 calls).
 */
export function createXPay(options: XPayOptions): XPay {
  // Resolve networks + signers from either the manual config or a profile.
  let networks: Network[] | undefined = options.networks;
  let signers: Partial<Record<Network, Signer>> | undefined = options.signers;
  let guardrailConfig: GuardrailConfig | undefined = options.guardrail;

  if (options.profile) {
    networks ??= options.profile.config.networks;
    signers ??= signersFromProfile(options.profile);
    guardrailConfig ??= options.profile.config.guardrail;

    // Bento intent firewall: thread the enable flag into the guardrail and
    // expose the wallet key to @bentoguard/sdk, which reads it from
    // AGENT_WALLET_PRIVATE_KEY. Bento authenticates by signing a challenge
    // with this key — there is no separate API key.
    if (options.profile.config.bento?.enabled) {
      guardrailConfig = { ...guardrailConfig, bento: { enabled: true } };
      if (!process.env.AGENT_WALLET_PRIVATE_KEY) {
        process.env.AGENT_WALLET_PRIVATE_KEY = deriveKeysFromMnemonic(
          options.profile.mnemonic,
        ).solana.secretKeyBase58;
      }
    }
  }

  if (!networks?.length) {
    throw new Error("createXPay: at least one network must be configured (via `networks` or `profile`)");
  }
  if (!signers || Object.keys(signers).length === 0) {
    throw new Error("createXPay: at least one signer must be provided (via `signers` or `profile`)");
  }

  const walletOpts: WalletOptions = { networks, signers };
  const wallet = createWallet(walletOpts);
  const guardrail = new Guardrail(guardrailConfig);

  const agencConfig = options.profile?.config.agenc;

  return {
    wallet,
    guardrail,
    discover: (opts) => discover({ ...opts, endpoint: options.discoveryEndpoint }),
    use: (resource, opts) => use({ resource, wallet, guardrail, agenc: agencConfig, ...opts }),
    useByUrl: (url, opts) => useByUrl({ url, wallet, guardrail, ...opts }),
    do: (query, opts) => doIt({ query, wallet, guardrail, agenc: agencConfig, ...opts }),
    report: (opts) => {
      // Pick the primary network's address for the report (first configured network).
      const net = opts?.network ?? networks[0] ?? "solana";
      const address = wallet.address(net);
      return fetchReport(address, opts);
    },
    transfer: (args) => transfer({
      ...args,
      wallet,
      guardrail,
      magicBlockConfig: options.profile?.config.magicblock,
    }),
    findTokens: (query, opts) => findTokens(query, {
      endpoint: options.profile?.config.swap?.endpoint,
      apiKey: options.profile?.config.swap?.apiKey,
      ...opts,
    }),
    swapQuote: (args) => swapQuote({ ...args, wallet, config: options.profile?.config.swap }),
    swap: (args) => swap({ ...args, wallet, guardrail, config: options.profile?.config.swap }),
    tradeQuote: (args) => tradeQuote({ ...args, wallet, config: options.profile?.config.trading }),
    trade: (args) => trade({ ...args, wallet, guardrail, config: options.profile?.config.trading }),
    trendingTokens: (opts) => trendingTokens(opts),
    newTokens: (opts) => newTokens(opts),
  };
}
