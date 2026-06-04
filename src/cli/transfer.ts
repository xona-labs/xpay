/**
 * `xpay transfer <amount> <token> <to>` — send SPL tokens or USDC.
 *
 * Examples:
 *   xpay transfer 5 USDC 7G73PL...gC
 *   xpay transfer 1000 BONK 7G73PL...gC --private
 *   xpay transfer 0.5 JUP 7G73PL...gC
 *   xpay transfer 1 USDC 0x47ff...5552 --network base
 *
 * Solana: USDC, USDT, wSOL, mSOL, JitoSOL, BONK, JUP, PYTH, or any mint address.
 * EVM:    USDC only.
 * Network is auto-detected from the address shape (0x → EVM, else Solana).
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import type { Network } from "../types.js";
import { unlockActive, formatUsd, shortAddress } from "./common.js";

export interface TransferCmdOptions {
  profile?: string;
  passphrase?: string;
  network?: Network;
  yes?: boolean;
  private?: boolean;
}

export async function runTransfer(
  amountArg: string,
  tokenArg: string,
  to: string,
  opts: TransferCmdOptions,
): Promise<void> {
  const amount = Number(amountArg);
  if (!(amount > 0)) {
    console.error(chalk.red(`✗ amount must be a positive number (got "${amountArg}")`));
    process.exit(1);
  }
  const token = tokenArg.toUpperCase();
  if (!to) {
    console.error(chalk.red("✗ usage: xpay transfer <amount> <token> <to>"));
    process.exit(1);
  }

  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile });

  // Confirm.
  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Send ${chalk.bold(`${amount} ${token}`)} to ${chalk.cyan(shortAddress(to, 6, 6))}${
          opts.network ? ` on ${chalk.cyan(opts.network)}` : ""
        }${opts.private ? chalk.dim(" (private)") : ""}?`,
        default: false,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      return;
    }
  }

  try {
    if (opts.private) {
      console.log(chalk.dim("  Routing through MagicBlock Private Ephemeral Rollup..."));
    }
    const t0 = Date.now();
    const result = await xpay.transfer({
      amount,
      to,
      network: opts.network,
      token,
      private: opts.private,
    });
    const elapsed = Date.now() - t0;
    console.log("");
    console.log(
      chalk.green(`✔ Sent ${result.amount} ${result.token} on ${chalk.cyan(result.network)} in ${elapsed}ms`),
    );
    console.log(`  ${chalk.dim("→ to:")} ${result.to}`);
    console.log(`  ${chalk.dim("→ tx:")} ${result.txSig}`);
  } catch (err) {
    const e = err as Error & { logs?: unknown };
    const msg = e.message || e.toString() || "(no error message)";
    console.error(chalk.red(`\n✗ ${msg}`));
    if (e.logs) console.error(chalk.dim(JSON.stringify(e.logs).slice(0, 400)));
    process.exit(1);
  }
}
