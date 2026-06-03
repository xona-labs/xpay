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

  let usdcTotal = 0;

  for (const net of networks) {
    const signer = signers[net];
    if (!signer) {
      console.log(`  ${chalk.bold(net.padEnd(10))}  ${chalk.dim("(no signer)")}`);
      continue;
    }

    console.log(`  ${chalk.bold(net)}  ${chalk.dim(signer.address)}`);

    if (typeof (signer as any).tokenBalances === "function") {
      const tokens = await (signer as any).tokenBalances().catch(() => []);
      if (tokens.length === 0) {
        console.log(`    ${chalk.dim("(no balances)")}`);
      }
      for (const t of tokens) {
        const val = t.balance.toFixed(t.decimals <= 6 ? 4 : 6);
        const label = t.isNative ? chalk.yellow(t.symbol) : chalk.green(t.symbol);
        console.log(`    ${label.padEnd(18)}  ${chalk.white(val)}`);
        // Accumulate stablecoin total
        if (t.symbol === "USDC" || t.symbol === "USDT") usdcTotal += t.balance;
      }
    } else {
      // Fallback: USDC only
      const bal = signer.balance ? await signer.balance().catch(() => 0) : 0;
      usdcTotal += bal;
      console.log(`    ${chalk.green("USDC".padEnd(18))}  ${chalk.white(`$${bal.toFixed(4)}`)}`);
    }
    console.log("");
  }

  console.log(`  ${chalk.bold(`$${usdcTotal.toFixed(4)}`)} ${chalk.dim("stablecoin total (USDC + USDT)")}`);
}
