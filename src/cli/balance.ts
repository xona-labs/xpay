/**
 * `xpay balance` — show USDC balance per network for the active profile.
 *
 * Unlocks the active profile (prompts for passphrase if encrypted, unless
 * $XPAY_PASSPHRASE is set for non-interactive use), then queries each
 * configured network's USDC balance.
 */

import chalk from "chalk";
import { signersFromProfile } from "../profile/index.js";
import { enrichTokenBalances } from "../token/index.js";
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
  // Robinhood Chain always has a signer (see signersFromProfile) even when it's
  // not in the profile's `networks`, so surface it in the default view too —
  // handy as the deposit address for funding trades.
  const configured = profile.config.networks;
  const networks = opts.network
    ? [opts.network]
    : configured.includes("robinhood")
      ? configured
      : [...configured, "robinhood"];

  console.log("");
  console.log(chalk.bold(`Profile "${name}"`));
  console.log("");

  let usdcTotal = 0;
  let portfolioUsd = 0;
  let portfolioComplete = true;

  for (const net of networks) {
    const signer = signers[net];
    if (!signer) {
      console.log(`  ${chalk.bold(net.padEnd(10))}  ${chalk.dim("(no signer)")}`);
      continue;
    }

    console.log(`  ${chalk.bold(net)}  ${chalk.dim(signer.address)}`);

    if (typeof (signer as any).tokenBalances === "function") {
      const raw = await (signer as any).tokenBalances().catch(() => []);
      // Label unknown mints + attach USD values via one batched Jupiter
      // lookup (Solana only; EVM balances pass through unchanged).
      const tokens = net === "solana" ? await enrichTokenBalances(raw) : raw;
      if (tokens.length === 0) {
        console.log(`    ${chalk.dim("(no balances)")}`);
      }
      for (const t of tokens) {
        const val = t.balance.toFixed(t.decimals <= 6 ? 4 : 6);
        const label = t.isNative ? chalk.yellow(t.symbol) : chalk.green(t.symbol);
        const usd = t.usdValue !== undefined ? chalk.dim(`≈ $${t.usdValue.toFixed(2)}`) : "";
        const flag = t.verified === false && !t.isNative ? chalk.yellow(" ⚠ unverified") : "";
        console.log(`    ${label.padEnd(18)}  ${chalk.white(val.padEnd(14))} ${usd}${flag}`);
        if (t.symbol === "USDC" || t.symbol === "USDT") usdcTotal += t.balance;
        if (t.usdValue !== undefined) portfolioUsd += t.usdValue;
        else portfolioComplete = false;
      }
    } else {
      // Fallback: USDC only
      const bal = signer.balance ? await signer.balance().catch(() => 0) : 0;
      usdcTotal += bal;
      portfolioUsd += bal;
      console.log(`    ${chalk.green("USDC".padEnd(18))}  ${chalk.white(`$${bal.toFixed(4)}`)}`);
    }
    console.log("");
  }

  console.log(`  ${chalk.bold(`$${usdcTotal.toFixed(4)}`)} ${chalk.dim("stablecoin total (USDC + USDT)")}`);
  if (portfolioUsd > 0) {
    console.log(
      `  ${chalk.bold(`$${portfolioUsd.toFixed(2)}`)} ${chalk.dim(`portfolio total${portfolioComplete ? "" : " (some tokens unpriced)"}`)}`,
    );
  }
}
