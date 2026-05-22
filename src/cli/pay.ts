/**
 * `xpay pay <url>` — pay an x402 endpoint.
 *
 * Accepts either a catalog URL (we resolve metadata via discover) or any
 * URL that returns HTTP 402 (live challenge mode).
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { unlockActive, formatUsd } from "./common.js";

export interface PayCmdOptions {
  profile?: string;
  passphrase?: string;
  maxUsd?: string;
  body?: string;
  yes?: boolean;
}

export async function runPay(url: string, opts: PayCmdOptions): Promise<void> {
  if (!url) {
    console.error(chalk.red("✗ usage: xpay pay <url> [--max-usd N] [--body '{...}']"));
    process.exit(1);
  }

  const profile = await unlockActive(opts);

  // Optional guardrail override from the command line.
  if (opts.maxUsd) {
    profile.config.guardrail = {
      ...profile.config.guardrail,
      maxPerTx: Number(opts.maxUsd),
    };
  }

  const xpay = createXPay({ profile });

  // Pre-flight: parse the body if supplied.
  let body: unknown;
  if (opts.body) {
    try {
      body = JSON.parse(opts.body);
    } catch {
      console.error(chalk.red("✗ --body must be valid JSON"));
      process.exit(1);
    }
  }

  // Confirm spend if interactive and no --yes.
  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Pay and call ${chalk.cyan(url)}? (caps: ${
          profile.config.guardrail?.maxPerTx
            ? `$${profile.config.guardrail.maxPerTx}/tx`
            : "none"
        })`,
        default: true,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      return;
    }
  }

  const t0 = Date.now();
  try {
    const result = await xpay.useByUrl(url, { body });
    const elapsed = Date.now() - t0;
    const amount = Number(result.amountPaid) / 1_000_000;

    console.log("");
    console.log(chalk.green(`✔ Paid ${formatUsd(amount)} on ${chalk.cyan(result.network)} in ${elapsed}ms`));
    if (result.txSig) {
      console.log(`  ${chalk.dim("tx:")} ${result.txSig}`);
    }
    console.log("");
    console.log(chalk.bold("Response:"));
    const display =
      typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
    console.log(display.slice(0, 2000));
    if (display.length > 2000) console.log(chalk.dim(`\n  ...truncated (${display.length} chars total)`));
  } catch (err) {
    console.error("");
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}
