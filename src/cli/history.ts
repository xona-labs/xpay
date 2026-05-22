/**
 * `xpay history` — recent USDC activity across all configured networks.
 *
 * Public-RPC powered by default. EVM scans a recent block window
 * (~100k blocks ≈ 2 days on Base); pass --evm-window to widen.
 */

import chalk from "chalk";
import { createXPay } from "../index.js";
import { unlockActive, shortAddress, timeAgo, formatUsd } from "./common.js";

export interface HistoryCmdOptions {
  profile?: string;
  passphrase?: string;
  network?: string;
  limit?: string;
  evmWindow?: string;
  json?: boolean;
}

export async function runHistory(opts: HistoryCmdOptions): Promise<void> {
  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile });

  const limit = opts.limit ? Number(opts.limit) : 25;
  const networks = opts.network ? [opts.network] : undefined;
  const evmBlockWindow = opts.evmWindow ? Number(opts.evmWindow) : undefined;

  const t0 = Date.now();
  let entries;
  try {
    entries = await xpay.history({ limit, networks, evmBlockWindow });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
  const elapsed = Date.now() - t0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return;
  }

  if (entries.length === 0) {
    console.log(chalk.yellow("No USDC activity in the scanned window."));
    console.log(chalk.dim("Tip: widen the EVM window with --evm-window 500000, or run `xpay balance`."));
    return;
  }

  console.log("");
  console.log(chalk.dim(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${elapsed}ms)`));
  console.log("");

  // Header
  console.log(
    chalk.dim(
      "  TIME".padEnd(12) +
        "NETWORK".padEnd(10) +
        "DIR".padEnd(10) +
        "AMOUNT".padEnd(14) +
        "COUNTERPARTY".padEnd(18) +
        "TX",
    ),
  );

  for (const e of entries) {
    const dir = e.direction === "send" ? chalk.red("→ send") : chalk.green("← recv");
    const amount = formatUsd(e.amountUsdc).padEnd(20); // padEnd ignores ANSI codes
    console.log(
      "  " +
        timeAgo(e.timestamp).padEnd(12) +
        chalk.cyan(e.network.padEnd(10)) +
        dir.padEnd(18) + // padEnd ignores ANSI
        formatUsd(e.amountUsdc).padEnd(20) +
        chalk.white(shortAddress(e.counterparty, 6, 6).padEnd(18)) +
        chalk.dim(shortAddress(e.signature, 6, 6)),
    );
    void amount;
  }
  console.log("");
}
