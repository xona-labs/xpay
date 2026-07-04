/**
 * `xpay swap <amount> <fromToken> <toToken>` — swap tokens in the wallet via
 * Jupiter (Solana only). Subject to the active guardrail, enforced before
 * signing. Shows a quote and asks for confirmation unless `-y`.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import type { SwapQuote } from "../swap/index.js";
import { unlockActive, guardrailWithApproval } from "./common.js";

export interface SwapCmdOptions {
  profile?: string;
  passphrase?: string;
  slippageBps?: string;
  yes?: boolean;
}

export async function runSwap(
  amountRaw: string,
  fromToken: string,
  toToken: string,
  opts: SwapCmdOptions,
): Promise<void> {
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(chalk.red("✗ amount must be a positive number, e.g. `xpay swap 0.5 SOL BONK`"));
    process.exit(1);
  }
  const slippageBps = opts.slippageBps ? Number(opts.slippageBps) : undefined;

  // Unlock first — Jupiter needs the wallet address (taker) even for a quote.
  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile) });

  let quote: SwapQuote;
  try {
    quote = await xpay.swapQuote({ amount, from: fromToken, to: toToken, slippageBps });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  const usd = quote.usdValue !== undefined ? ` (~$${quote.usdValue.toFixed(2)})` : "";
  console.log("");
  console.log(
    `  Swap ${chalk.bold(`${quote.inAmount} ${quote.from.symbol}`)}${usd} → ~${chalk.bold(
      `${quote.outAmount.toLocaleString()} ${quote.to.symbol}`,
    )}`,
  );
  const impact = quote.priceImpactPct !== undefined ? `, impact ${(quote.priceImpactPct * 100).toFixed(3)}%` : "";
  const slip = quote.slippageBps !== undefined ? `${quote.slippageBps} bps` : "dynamic";
  console.log(chalk.dim(`  router ${quote.router}, slippage ${slip}${impact}`));
  if (quote.outputUnverified) {
    console.log("");
    console.log(chalk.yellow(`  ⚠ ${quote.to.symbol} (${quote.to.mint}) is NOT verified on Jupiter.`));
    console.log(chalk.yellow("    Unverified tokens can be scams reusing a real ticker — verify the mint."));
  }
  console.log("");

  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Execute this swap? (irreversible; caps: ${
          profile.config.guardrail?.maxPerTx ? `$${profile.config.guardrail.maxPerTx}/tx` : "none"
        })`,
        default: false,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      return;
    }
  }

  const t0 = Date.now();
  try {
    const result = await xpay.swap({ amount, from: fromToken, to: toToken, slippageBps });
    const elapsed = Date.now() - t0;

    const inShown = result.totalInAmount ?? result.inAmount;
    const outShown = result.totalOutAmount ?? result.outAmount;
    console.log("");
    console.log(
      chalk.green(
        `✔ Swapped ${inShown} ${result.from.symbol} → ${outShown.toLocaleString()} ${result.to.symbol} in ${elapsed}ms`,
      ),
    );
    console.log(`  ${chalk.dim("tx:")}       ${result.txSig}`);
    console.log(`  ${chalk.dim("explorer:")} https://solscan.io/tx/${result.txSig}`);
  } catch (err) {
    const e = err as Error & { logs?: unknown };
    console.error("");
    console.error(chalk.red(`✗ ${e.message || String(e)}`));
    if (e.logs) console.error(chalk.dim(JSON.stringify(e.logs).slice(0, 400)));
    process.exit(1);
  }
}
