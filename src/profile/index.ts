/**
 * Profile API — public SDK surface for keyfile management.
 *
 * Programmatic usage:
 * ```ts
 * import { initProfile, loadProfile, listProfiles } from "@xona-labs/xpay";
 *
 * const created = await initProfile({ name: "default", passphrase: "..." });
 * console.log(created.mnemonic);             // back this up!
 * console.log(created.addresses);            // { solana, evm }
 *
 * const p = await loadProfile({ name: "default", passphrase: "..." });
 * // → can be fed directly to createXPay({ profile: p })
 * ```
 *
 * CLI usage is a thin wrapper around these functions.
 */

import { addressesFromMnemonic, generateNewMnemonic, deriveKeysFromMnemonic } from "./derive.js";
import {
  buildWalletFile,
  defaultConfig,
  listProfiles as listProfilesFn,
  profileExists,
  profilePath,
  readConfigFile,
  readWalletFile,
  unlockWalletFile,
  writeConfigFile,
  writeWalletFile,
} from "./storage.js";
import type { LoadedProfile, ProfileConfig, WalletFile } from "./types.js";
import type { Signer } from "../types.js";
import { rawSolanaSigner } from "../signers/raw-solana.js";
import { rawEvmSigner } from "../signers/raw-evm.js";

export * from "./types.js";
export { generateNewMnemonic, addressesFromMnemonic } from "./derive.js";
export { xpayHome, workspaceXpayDir, listProfiles } from "./storage.js";

// -----------------------------------------------------------------------------
// init
// -----------------------------------------------------------------------------

export interface InitProfileOptions {
  /** Profile name, defaults to "default". */
  name?: string;
  /** Use existing mnemonic (import) instead of generating one. */
  mnemonic?: string;
  /** Encrypt at rest. Strongly recommended — omit only for ephemeral dev wallets. */
  passphrase?: string;
  /** Use workspace-local `.xpay/` instead of `~/.xpay/`. */
  workspace?: boolean | string;
  /** Overwrite an existing profile with the same name. Default false. */
  overwrite?: boolean;
  /** Override initial config (defaults to Solana + Base). */
  config?: Partial<ProfileConfig>;
}

export interface InitProfileResult {
  name: string;
  path: string;
  addresses: WalletFile["addresses"];
  /** Returned once at creation so the caller can show/save it. Never persisted in plaintext when a passphrase is set. */
  mnemonic: string;
  encrypted: boolean;
}

export async function initProfile(opts: InitProfileOptions = {}): Promise<InitProfileResult> {
  const name = opts.name ?? "default";
  if (!opts.overwrite && profileExists(name, { workspace: opts.workspace })) {
    throw new Error(`Profile "${name}" already exists. Pass { overwrite: true } to replace it.`);
  }
  const mnemonic = opts.mnemonic ?? generateNewMnemonic();
  const addresses = addressesFromMnemonic(mnemonic);
  const wallet = buildWalletFile({ mnemonic, addresses, passphrase: opts.passphrase });
  const dir = profilePath(name, { workspace: opts.workspace });
  writeWalletFile(dir, wallet);
  writeConfigFile(dir, { ...defaultConfig(), ...opts.config });

  return {
    name,
    path: dir,
    addresses,
    mnemonic,
    encrypted: Boolean(opts.passphrase),
  };
}

// -----------------------------------------------------------------------------
// load
// -----------------------------------------------------------------------------

export interface LoadProfileOptions {
  name?: string;
  passphrase?: string;
  workspace?: boolean | string;
}

export async function loadProfile(opts: LoadProfileOptions = {}): Promise<LoadedProfile> {
  const name = opts.name ?? "default";
  const dir = profilePath(name, { workspace: opts.workspace });
  const wallet = readWalletFile(dir);
  const mnemonic = unlockWalletFile(wallet, opts.passphrase);
  return {
    name,
    path: dir,
    addresses: wallet.addresses,
    config: readConfigFile(dir),
    mnemonic,
  };
}

// -----------------------------------------------------------------------------
// signers from profile
// -----------------------------------------------------------------------------

/**
 * Build runtime signers for every network in the profile's config. Used by
 * createXPay when called with `{ profile }`.
 */
export function signersFromProfile(profile: LoadedProfile): Partial<Record<string, Signer>> {
  const keys = deriveKeysFromMnemonic(profile.mnemonic);
  const out: Partial<Record<string, Signer>> = {};
  for (const network of profile.config.networks) {
    if (network === "solana") {
      out.solana = rawSolanaSigner({
        secretKey: keys.solana.keypair.secretKey,
        rpcUrl: profile.config.rpcs?.solana,
      });
    } else if (["base", "ethereum", "arbitrum", "optimism"].includes(network)) {
      out[network] = rawEvmSigner({
        privateKey: keys.evm.privateKey,
        network,
        rpcUrl: profile.config.rpcs?.[network],
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Guardrail mutation
// -----------------------------------------------------------------------------

/**
 * Update a profile's guardrail on disk. Merges with any existing guardrail
 * (pass undefined to a field to leave it alone; pass null to clear it).
 */
export function setProfileGuardrail(
  name: string,
  guardrail: NonNullable<ProfileConfig["guardrail"]>,
  opts: { workspace?: boolean | string } = {},
): ProfileConfig {
  const dir = profilePath(name, opts);
  const current = readConfigFile(dir);
  current.guardrail = { ...current.guardrail, ...guardrail };
  writeConfigFile(dir, current);
  return current;
}

// -----------------------------------------------------------------------------
// Sana integration
// -----------------------------------------------------------------------------

/** Persist a Sana API key for the profile. MCP picks it up on next start. */
export function setSanaApiKey(
  name: string,
  apiKey: string,
  opts: { workspace?: boolean | string } = {},
): ProfileConfig {
  const dir = profilePath(name, opts);
  const current = readConfigFile(dir);
  current.sana = { apiKey };
  writeConfigFile(dir, current);
  return current;
}

/** Remove the Sana API key — sana_* tools will no longer be registered. */
export function clearSanaApiKey(
  name: string,
  opts: { workspace?: boolean | string } = {},
): ProfileConfig {
  const dir = profilePath(name, opts);
  const current = readConfigFile(dir);
  delete current.sana;
  writeConfigFile(dir, current);
  return current;
}

/** Drop the guardrail entirely (calls now run unconstrained). */
export function clearProfileGuardrail(
  name: string,
  opts: { workspace?: boolean | string } = {},
): ProfileConfig {
  const dir = profilePath(name, opts);
  const current = readConfigFile(dir);
  delete current.guardrail;
  writeConfigFile(dir, current);
  return current;
}

/** Read the on-disk config (guardrail, networks, link, etc.) for a profile. */
export function readProfileConfig(
  name: string,
  opts: { workspace?: boolean | string } = {},
): ProfileConfig {
  return readConfigFile(profilePath(name, opts));
}

// -----------------------------------------------------------------------------
// re-export for convenience
// -----------------------------------------------------------------------------

export { profilePath, profileExists } from "./storage.js";
export { deriveKeysFromMnemonic } from "./derive.js";
