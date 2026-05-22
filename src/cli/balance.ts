/**
 * `xpay balance` — show USDC balance per network for the active profile.
 *
 * Unlocks the active profile (prompts for passphrase if encrypted, unless
 * $XPAY_PASSPHRASE is set for non-interactive use), then queries each
 * configured network's USDC balance.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { loadProfile, signersFromProfile } from "../profile/index.js";
import { profileExists } from "../profile/storage.js";
import { readWalletFile } from "../profile/storage.js";
import { profilePath } from "../profile/storage.js";
import { getActiveProfile } from "./accounts.js";

export interface BalanceCmdOptions {
  profile?: string;
  network?: string;
  passphrase?: string;
}

export async function runBalance(opts: BalanceCmdOptions): Promise<void> {
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

  let profile;
  try {
    profile = await loadProfile({ name, passphrase });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  const signers = signersFromProfile(profile);
  const networks = opts.network ? [opts.network] : profile.config.networks;

  console.log("");
  console.log(chalk.bold(`Profile "${name}"`));
  console.log("");

  let total = 0;
  const rows: Array<{ network: string; address: string; balance: number }> = [];
  for (const net of networks) {
    const signer = signers[net];
    if (!signer) {
      rows.push({ network: net, address: chalk.dim("(no signer)"), balance: 0 });
      continue;
    }
    const bal = signer.balance ? await signer.balance().catch(() => 0) : 0;
    total += bal;
    rows.push({ network: net, address: signer.address, balance: bal });
  }

  for (const r of rows) {
    console.log(
      `  ${chalk.bold(r.network.padEnd(10))}  ${chalk.cyan(r.address)}  ${chalk.green(
        `$${r.balance.toFixed(4)}`,
      )} ${chalk.dim("USDC")}`,
    );
  }
  console.log("");
  console.log(`  ${" ".repeat(10)}  ${" ".repeat(44)}  ${chalk.bold(`$${total.toFixed(4)} total`)}`);
}
