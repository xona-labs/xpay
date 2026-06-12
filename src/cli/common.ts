/**
 * Shared CLI helpers: unlock the active profile, format addresses + amounts.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { loadProfile } from "../profile/index.js";
import { profileExists, readWalletFile, readConfigFile, profilePath } from "../profile/storage.js";
import {
  BiometricUnavailableError,
  biometricPrompt,
  readBiometricPassphrase,
} from "../biometric/index.js";
import { getActiveProfile } from "./accounts.js";
import type { LoadedProfile } from "../profile/index.js";
import type { GuardrailConfig } from "../guardrail/index.js";

export interface UnlockOptions {
  profile?: string;
  passphrase?: string;
}

/**
 * Resolve + unlock the active profile, prompting for passphrase if needed.
 * Order: explicit option → $XPAY_PASSPHRASE → biometric (Touch ID, when
 * enabled via `xpay biometric enable`) → interactive prompt.
 */
export async function unlockActive(opts: UnlockOptions = {}): Promise<LoadedProfile> {
  const name = opts.profile ?? getActiveProfile();
  if (!profileExists(name)) {
    console.error(chalk.red(`✗ Profile "${name}" not found. Run \`xpay init\` first.`));
    process.exit(1);
  }

  const wallet = readWalletFile(profilePath(name));
  let passphrase = opts.passphrase ?? process.env.XPAY_PASSPHRASE;
  let viaBiometric = false;

  if (wallet.encrypted && !passphrase) {
    const fromKeychain = await tryBiometricUnlock(name);
    if (fromKeychain) {
      passphrase = fromKeychain;
      viaBiometric = true;
    }
  }

  if (wallet.encrypted && !passphrase) {
    passphrase = await promptPassphrase(name);
  }

  try {
    return await loadProfile({ name, passphrase });
  } catch (err) {
    // The keychain copy can go stale if the wallet was re-encrypted with a
    // new passphrase — give the user one interactive retry instead of dying.
    if (viaBiometric && process.stdin.isTTY) {
      console.error(
        chalk.yellow(
          `⚠ The passphrase stored for Touch ID no longer unlocks "${name}" — run \`xpay biometric enable\` to refresh it.`,
        ),
      );
      try {
        return await loadProfile({ name, passphrase: await promptPassphrase(name) });
      } catch (err2) {
        console.error(chalk.red(`✗ ${(err2 as Error).message}`));
        process.exit(1);
      }
    }
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}

async function promptPassphrase(name: string): Promise<string> {
  const a = await inquirer.prompt<{ p: string }>([
    { type: "password", name: "p", message: `Passphrase for "${name}":`, mask: "*" },
  ]);
  return a.p;
}

/** Touch ID keychain read; resolves undefined whenever falling back to typing is the answer. */
async function tryBiometricUnlock(name: string): Promise<string | undefined> {
  const config = readConfigFile(profilePath(name));
  if (!config.biometric?.enabled) return undefined;
  try {
    const passphrase = await readBiometricPassphrase(name, `unlock the xPay profile "${name}"`);
    if (!passphrase && process.stdin.isTTY) {
      console.log(chalk.dim("  (biometric unlock cancelled — enter the passphrase instead)"));
    }
    return passphrase ?? undefined;
  } catch (err) {
    if (err instanceof BiometricUnavailableError) return undefined;
    throw err;
  }
}

/**
 * Guardrail config with the approval hook wired up: Touch ID when the
 * profile has biometric unlock enabled, otherwise a y/n prompt on a TTY.
 * Without either, calls above `requireApprovalAbove` are denied.
 */
export function guardrailWithApproval(
  profile: LoadedProfile,
  opts: { interactive?: boolean } = {},
): GuardrailConfig {
  const interactive = opts.interactive ?? true;
  return {
    ...profile.config.guardrail,
    onApprovalRequired: async ({ resource, usd }) => {
      const target = resource.type === "transfer" ? "a direct transfer" : resource.resource;
      if (profile.config.biometric?.enabled) {
        try {
          return await biometricPrompt(`approve a $${usd.toFixed(2)} xPay payment to ${target}`);
        } catch (err) {
          if (!(err instanceof BiometricUnavailableError)) throw err;
          // Biometry unavailable right now (e.g. lid closed) — fall through.
        }
      }
      if (interactive && process.stdin.isTTY) {
        const { ok } = await inquirer.prompt<{ ok: boolean }>([
          {
            type: "confirm",
            name: "ok",
            message: `Approve ${formatUsd(usd)} for ${chalk.cyan(target)}? (above your approval threshold)`,
            default: false,
          },
        ]);
        return ok;
      }
      console.error(
        chalk.yellow(
          `⚠ $${usd.toFixed(2)} call needs approval but no biometric or interactive terminal is available — denying.`,
        ),
      );
      return false;
    },
  };
}

/** Compact display for long addresses: `7RB7...f5ph`. */
export function shortAddress(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** "$0.0123 USDC", consistent width. */
export function formatUsd(amount: number): string {
  return chalk.green(`$${amount.toFixed(4)}`);
}

/** "2m ago" / "3h ago" / "5d ago". */
export function timeAgo(ts: number | null): string {
  if (!ts) return chalk.dim("—");
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
