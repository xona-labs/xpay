/**
 * `xpay report` — comprehensive USDC activity report via OrbitX402.
 *
 * Fetches daily / weekly / monthly aggregated data from the OrbitX402 API
 * (on-chain data is resolved server-side — no RPC calls from the CLI).
 */

import chalk from "chalk";
import { createXPay } from "../index.js";
import { unlockActive, shortAddress, formatUsd } from "./common.js";
import type { ReportPeriod } from "../report/index.js";

export interface ReportCmdOptions {
  profile?: string;
  passphrase?: string;
  network?: string;
  period?: string;
  json?: boolean;
}

export async function runReport(opts: ReportCmdOptions): Promise<void> {
  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile });

  const period = (opts.period ?? "weekly") as ReportPeriod;
  const validPeriods = ["daily", "weekly", "monthly"];
  if (!validPeriods.includes(period)) {
    console.error(chalk.red(`✗ Invalid period "${period}". Choose: daily, weekly, monthly.`));
    process.exit(1);
  }

  const t0 = Date.now();
  let report;
  try {
    report = await xpay.report({ period, network: opts.network });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
  const elapsed = Date.now() - t0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  const { summary, timeline, topCounterparties, topTransactions } = report;

  const periodLabel = { daily: "Last 24h", weekly: "Last 7 days", monthly: "Last 30 days" }[period];

  console.log("");
  console.log(chalk.bold(`  USDC Report — ${periodLabel}`));
  console.log(chalk.dim(`  ${report.address}  ·  ${report.network}  ·  ${elapsed}ms`));
  console.log("");

  // Summary
  console.log(chalk.dim("  ── Summary ────────────────────────────────────────"));
  console.log(
    "  " +
      chalk.green(`Received  ${formatUsd(summary.totalReceived).padEnd(16)}`) +
      chalk.red(`Sent  ${formatUsd(summary.totalSent).padEnd(16)}`) +
      (summary.netFlow >= 0
        ? chalk.green(`Net  +${formatUsd(summary.netFlow)}`)
        : chalk.red(`Net  ${formatUsd(summary.netFlow)}`))
  );
  console.log(chalk.dim(`  ${summary.txCount} transaction${summary.txCount === 1 ? "" : "s"} · ${summary.asset}`));
  console.log("");

  // Timeline
  const hasActivity = timeline.some(d => d.txCount > 0);
  if (hasActivity) {
    console.log(chalk.dim("  ── Timeline ───────────────────────────────────────"));
    for (const day of timeline) {
      if (day.txCount === 0) continue;
      const bar = "█".repeat(Math.min(Math.round((day.received + day.sent) / 5), 20));
      console.log(
        `  ${chalk.dim(day.date)}  ` +
          chalk.green(`+${formatUsd(day.received)}`).padEnd(20) +
          chalk.red(`-${formatUsd(day.sent)}`).padEnd(20) +
          chalk.cyan(bar)
      );
    }
    console.log("");
  }

  // Top counterparties
  if (topCounterparties.length > 0) {
    console.log(chalk.dim("  ── Top Counterparties ─────────────────────────────"));
    console.log(
      chalk.dim(
        "  " + "ADDRESS".padEnd(16) + "RECEIVED".padEnd(16) + "SENT".padEnd(16) + "TXS"
      )
    );
    for (const cp of topCounterparties.slice(0, 5)) {
      console.log(
        "  " +
          chalk.white(shortAddress(cp.address, 6, 4).padEnd(16)) +
          chalk.green(formatUsd(cp.received).padEnd(16)) +
          chalk.red(formatUsd(cp.sent).padEnd(16)) +
          chalk.dim(String(cp.txCount))
      );
    }
    console.log("");
  }

  // Top transactions
  if (topTransactions.length > 0) {
    console.log(chalk.dim("  ── Biggest Transactions ───────────────────────────"));
    for (const tx of topTransactions.slice(0, 5)) {
      const dir = tx.direction === "sent" ? chalk.red("→ sent") : chalk.green("← recv");
      const ts = tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : "—";
      console.log(
        "  " +
          chalk.dim(ts.padEnd(12)) +
          dir.padEnd(18) +
          chalk.bold(formatUsd(tx.amount).padEnd(16)) +
          chalk.white(shortAddress(tx.counterparty, 6, 4).padEnd(16)) +
          chalk.dim(shortAddress(tx.txHash, 6, 4))
      );
    }
    console.log("");
  }

  if (summary.txCount === 0) {
    console.log(chalk.yellow("  No USDC activity in this period."));
    console.log("");
  }
}
