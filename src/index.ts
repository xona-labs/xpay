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
import { signersFromProfile, type LoadedProfile } from "./profile/index.js";
import { getHistory, type HistoryEntry, type HistoryOptions } from "./history/index.js";
import { transfer, type TransferResult } from "./transfer/index.js";
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
export * from "./history/index.js";
export * from "./transfer/index.js";
export { Guardrail } from "./guardrail/index.js";
/**
 * Direct access to the discovery layer for callers (e.g. server routes) that
 * want catalog data without configuring signers.
 */
export { discover } from "./discover/index.js";
export { fetchPayAIResources } from "./discover/payai.js";
export { fetchOrbitX402Resources } from "./discover/orbitx402.js";

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
  /** Recent USDC activity across all configured networks (merged + sorted). */
  history(opts?: HistoryOptions): Promise<HistoryEntry[]>;
  /** Direct USDC transfer (no x402). Subject to the same guardrail. */
  transfer(args: { amount: number; to: string; network?: Network; token?: "USDC" }): Promise<TransferResult>;
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

  return {
    wallet,
    guardrail,
    discover: (opts) => discover({ ...opts, endpoint: options.discoveryEndpoint }),
    use: (resource, opts) => use({ resource, wallet, guardrail, ...opts }),
    useByUrl: (url, opts) => useByUrl({ url, wallet, guardrail, ...opts }),
    do: (query, opts) => doIt({ query, wallet, guardrail, ...opts }),
    history: (opts) => getHistory(wallet, opts),
    transfer: (args) => transfer({ ...args, wallet, guardrail }),
  };
}
