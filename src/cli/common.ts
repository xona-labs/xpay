/**
 * Shared CLI helpers: unlock the active profile, format addresses + amounts.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { loadProfile } from "../profile/index.js";
import { profileExists, readWalletFile, profilePath } from "../profile/storage.js";
import { getActiveProfile } from "./accounts.js";
import type { LoadedProfile } from "../profile/index.js";

export interface UnlockOptions {
  profile?: string;
  passphrase?: string;
}

/**
 * Resolve + unlock the active profile, prompting for passphrase if needed.
 * Falls back to $XPAY_PASSPHRASE so non-interactive use stays simple.
 */
export async function unlockActive(opts: UnlockOptions = {}): Promise<LoadedProfile> {
  const name = opts.profile ?? getActiveProfile();
  if (!profileExists(name)) {
    console.error(chalk.red(`✗ Profile "${name}" not found. Run \`xpay init\` first.`));
    process.exit(1);
  }

  const wallet = readWalletFile(profilePath(name));
  let passphrase = opts.passphrase ?? process.env.XPAY_PASSPHRASE;

  if (wallet.encrypted && !passphrase) {
    const a = await inquirer.prompt<{ p: string }>([
      { type: "password", name: "p", message: `Passphrase for "${name}":`, mask: "*" },
    ]);
    passphrase = a.p;
  }

  try {
    return await loadProfile({ name, passphrase });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
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
