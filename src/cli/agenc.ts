/**
 * `xpay agenc <hire|status>` — AgenC marketplace (agenc.ag).
 *
 * AgenC listings show up in `xpay discover` alongside x402 services, but they
 * execute differently: hiring escrows the price in native SOL on-chain, the
 * provider works asynchronously, and funds settle after the buyer's review
 * window. `hire` runs that flow; `status` polls the resulting task.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { fetchAgencListing, fetchAgencTask, listingToResource } from "../agenc/api.js";
import type { AgencHireReceipt } from "../agenc/hire.js";
import { unlockActive, guardrailWithApproval } from "./common.js";

export interface AgencHireCmdOptions {
  profile?: string;
  passphrase?: string;
  maxUsd?: string;
  reviewWindow?: string;
  yes?: boolean;
}

export async function runAgencHire(listingPda: string, opts: AgencHireCmdOptions): Promise<void> {
  const listing = await fetchAgencListing(listingPda);
  if (!listing) {
    console.error(
      chalk.red(`✗ Listing ${listingPda} is not hireable (paused, retired, at capacity, or unmoderated).`),
    );
    console.error(chalk.dim("  Run `xpay discover` to see current AgenC listings."));
    process.exit(1);
  }

  const sol = Number(listing.priceLamports) / 1e9;
  const profile = await unlockActive(opts);

  if (opts.maxUsd) {
    profile.config.guardrail = {
      ...profile.config.guardrail,
      maxPerTx: Number(opts.maxUsd),
    };
  }
  if (opts.reviewWindow) {
    profile.config.agenc = {
      ...profile.config.agenc,
      reviewWindowSecs: Number(opts.reviewWindow),
    };
  }

  if (process.stdin.isTTY && !opts.yes) {
    console.log("");
    console.log(`  ${chalk.bold(listing.name || listingPda)}`);
    console.log(`  ${chalk.dim("price:")}    ◎${sol.toFixed(4)} SOL (escrowed on-chain)`);
    console.log(`  ${chalk.dim("provider:")} ${listing.providerAgent}`);
    console.log(`  ${chalk.dim("track:")}    ${listing.totalHires ?? "0"} hires, ${listing.ratingCount ?? 0} ratings`);
    console.log("");
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message:
          `Escrow ◎${sol.toFixed(4)} SOL to hire this listing? ` +
          `The provider works asynchronously; funds settle after your review.`,
        default: true,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      return;
    }
  }

  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile) });

  const t0 = Date.now();
  try {
    const result = await xpay.use(listingToResource(listing));
    const receipt = result.data as AgencHireReceipt;
    const elapsed = Date.now() - t0;

    console.log("");
    console.log(chalk.green(`✔ Hired — ◎${sol.toFixed(4)} SOL escrowed in ${elapsed}ms`));
    console.log(`  ${chalk.dim("task:")}     ${receipt.task}`);
    console.log(`  ${chalk.dim("tx:")}       ${receipt.txSig}`);
    console.log(`  ${chalk.dim("explorer:")} ${receipt.explorer}`);
    console.log("");
    console.log(chalk.dim(`The provider now works asynchronously. Check progress with:`));
    console.log(chalk.cyan(`  xpay agenc status ${receipt.task}`));
  } catch (err) {
    const e = err as Error;
    console.error("");
    console.error(chalk.red(`✗ ${e.message || String(e)}`));
    process.exit(1);
  }
}

export interface AgencStatusCmdOptions {
  json?: boolean;
}

/** Read-only — no profile unlock needed. */
export async function runAgencStatus(taskPda: string, opts: AgencStatusCmdOptions): Promise<void> {
  try {
    const task = await fetchAgencTask(taskPda);

    if (opts.json) {
      process.stdout.write(JSON.stringify(task, null, 2) + "\n");
      return;
    }

    const statusColor =
      task.status === "settled" ? chalk.green :
      task.status === "cancelled" || task.status === "disputed" ? chalk.red :
      chalk.yellow;

    console.log("");
    console.log(`  ${chalk.bold(task.title || taskPda)}`);
    console.log(`  ${chalk.dim("status:")}  ${statusColor(task.status)}`);
    if (task.rewardLamports) {
      console.log(`  ${chalk.dim("escrow:")}  ◎${(Number(task.rewardLamports) / 1e9).toFixed(4)} SOL`);
    }
    if (task.workerPda) console.log(`  ${chalk.dim("worker:")}  ${task.workerPda}`);
    if (task.deadlineUnix) {
      console.log(`  ${chalk.dim("deadline:")} ${new Date(task.deadlineUnix * 1000).toISOString()}`);
    }
    console.log("");
    if (task.status === "review") {
      console.log(chalk.dim("The provider submitted a result — review it at:"));
      console.log(chalk.cyan(`  https://agenc.ag/tasks/${taskPda}`));
    } else if (!["settled", "cancelled", "disputed"].includes(task.status)) {
      console.log(chalk.dim("Escrow settles to the provider after review. Check again later."));
    }
  } catch (err) {
    const e = err as Error;
    console.error(chalk.red(`✗ ${e.message || String(e)}`));
    process.exit(1);
  }
}
