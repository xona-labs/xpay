/**
 * `xpay accounts` — multi-profile management.
 *
 *   xpay accounts list             list known profiles
 *   xpay accounts show [name]      show addresses for a profile
 *   xpay accounts use <name>       set the default profile (via ~/.xpay/active)
 */

import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listProfiles,
  profilePath,
  profileExists,
  xpayHome,
} from "../profile/storage.js";
import { readWalletFile } from "../profile/storage.js";

const ACTIVE_FILE = "active";

export function getActiveProfile(): string {
  const file = join(xpayHome(), ACTIVE_FILE);
  if (existsSync(file)) return readFileSync(file, "utf8").trim() || "default";
  return "default";
}

export function setActiveProfile(name: string): void {
  if (!profileExists(name)) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  writeFileSync(join(xpayHome(), ACTIVE_FILE), name);
}

export function runAccountsList(): void {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log(chalk.yellow("No profiles yet. Run `xpay init` to create one."));
    return;
  }
  const active = getActiveProfile();
  for (const name of profiles) {
    const marker = name === active ? chalk.green("●") : chalk.dim("○");
    const wallet = readWalletFile(profilePath(name));
    const encrypted = wallet.encrypted ? chalk.dim("(encrypted)") : chalk.red.dim("(unencrypted)");
    console.log(`  ${marker} ${chalk.bold(name)}  ${encrypted}`);
    console.log(`     Solana ${chalk.cyan(wallet.addresses.solana)}`);
    console.log(`     EVM    ${chalk.cyan(wallet.addresses.evm)}`);
  }
}

export function runAccountsShow(name?: string): void {
  const target = name ?? getActiveProfile();
  if (!profileExists(target)) {
    console.error(chalk.red(`✗ Profile "${target}" not found.`));
    process.exit(1);
  }
  const wallet = readWalletFile(profilePath(target));
  console.log(chalk.bold(`Profile "${target}"`));
  console.log(`  Path:      ${profilePath(target)}`);
  console.log(`  Encrypted: ${wallet.encrypted ? "yes" : chalk.red("no")}`);
  console.log(`  Created:   ${wallet.createdAt}`);
  console.log(`  Solana:    ${chalk.cyan(wallet.addresses.solana)}`);
  console.log(`  EVM:       ${chalk.cyan(wallet.addresses.evm)}`);
}

export function runAccountsUse(name: string): void {
  try {
    setActiveProfile(name);
    console.log(chalk.green(`✔ Active profile set to "${name}"`));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}
