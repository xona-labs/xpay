/**
 * `xpay balance` — show USDC balance per network for the active profile.
 *
 * Unlocks the active profile (prompts for passphrase if encrypted, unless
 * $XPAY_PASSPHRASE is set for non-interactive use), then queries each
 * configured network's USDC balance.
 */

import chalk from "chalk";
import { signersFromProfile } from "../profile/index.js";
import { unlockActive } from "./common.js";

export interface BalanceCmdOptions {
  profile?: string;
  network?: string;
  passphrase?: string;
}

export async function runBalance(opts: BalanceCmdOptions): Promise<void> {
  const profile = await unlockActive(opts);
  const name = profile.name;

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
