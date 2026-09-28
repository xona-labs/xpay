/**
 * `xpay orders ...` - standing stock orders (recurring buys, conditional
 * one-shots) stored in the profile, executed by `xpay orders run`.
 *
 * Only `run` unlocks the wallet; creating and managing orders reads/writes
 * `<profile>/orders.json` and never touches keys.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { profileExists, profilePath, readConfigFile } from "../profile/storage.js";
import {
  approveOrder,
  cancelOrder,
  createStockOrder,
  loadOrders,
  parseEvery,
  pauseOrder,
  resumeOrder,
  runDueOrders,
  type RunOrdersReport,
  type StockOrder,
} from "../orders/index.js";
import { getActiveProfile } from "./accounts.js";
import { guardrailWithApproval, unlockActive } from "./common.js";

interface ProfileOpt {
  profile?: string;
}

export interface OrdersAddOptions extends ProfileOpt {
  every?: string;
  start?: string;
  maxPremium?: string;
  minLiquidity?: string;
  marketHours?: boolean;
  budget?: string;
  maxFills?: string;
  expires?: string;
  slippageBps?: string;
  yes?: boolean;
  json?: boolean;
}

function ordersDir(opts: ProfileOpt): string {
  const name = opts.profile ?? getActiveProfile();
  if (!profileExists(name)) fail(`Profile "${name}" not found. Run \`xpay init\` first.`);
  return profilePath(name);
}

function fail(msg: string): never {
  console.error(chalk.red(`✗ ${msg}`));
  process.exit(1);
}

function num(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${flag} must be a number, got "${raw}"`);
  return n;
}

/** "7d" / "12h" / "2w" relative to now, or an ISO date. */
function parseWhen(raw: string, flag: string): string {
  const rel = /^(\d+)(h|d|w)$/.exec(raw.trim());
  if (rel) {
    const unit = { h: 3600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as "h" | "d" | "w"];
    return new Date(Date.now() + Number(rel[1]) * unit).toISOString();
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) fail(`${flag}: use a duration (7d, 12h, 2w) or an ISO date`);
  return d.toISOString();
}

export async function runOrdersAdd(
  side: string,
  amountRaw: string,
  stock: string,
  opts: OrdersAddOptions,
): Promise<void> {
  if (side !== "buy" && side !== "sell") fail(`side must be "buy" or "sell", got "${side}"`);
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) fail("amount must be a positive number, e.g. `xpay orders add buy 25 SPY --every weekly --budget 500`");
  const dir = ordersDir(opts);
  let every: string | undefined;
  try {
    every = opts.every ? parseEvery(opts.every) : undefined;
  } catch (err) {
    fail((err as Error).message);
  }

  const args = {
    side: side as "buy" | "sell",
    stock,
    amount,
    every,
    startAt: opts.start ? parseWhen(opts.start, "--start") : undefined,
    conditions: {
      maxPremiumPct: num(opts.maxPremium, "--max-premium"),
      minLiquidityUsd: num(opts.minLiquidity, "--min-liquidity"),
      marketOpenOnly: opts.marketHours || undefined,
      slippageBps: num(opts.slippageBps, "--slippage-bps"),
    },
    limits: {
      maxTotalUsd: num(opts.budget, "--budget"),
      maxFills: num(opts.maxFills, "--max-fills"),
      expiresAt: opts.expires ? parseWhen(opts.expires, "--expires") : undefined,
    },
    createdBy: "cli" as const,
  };

  if (every && args.limits.maxTotalUsd === undefined && args.limits.maxFills === undefined) {
    fail("a recurring order needs a cap: --budget <usd> and/or --max-fills <n>");
  }

  const unit = side === "buy" ? `$${amount}` : `${amount}`;
  console.log("");
  console.log(`  ${chalk.bold(side === "buy" ? "Buy" : "Sell")} ${chalk.bold(unit)} ${side === "sell" ? "tokens of " : "of "}${chalk.bold(stock)} ${every ? `every ${every}` : "once"}`);
  console.log(chalk.dim(`  conditions: premium ≤ ${args.conditions.maxPremiumPct ?? 2}%` +
    `${args.conditions.marketOpenOnly ? ", US market hours only" : ""}` +
    `${args.limits.maxTotalUsd !== undefined ? `, budget $${args.limits.maxTotalUsd}` : ""}` +
    `${args.limits.maxFills !== undefined ? `, max ${args.limits.maxFills} fills` : ""}` +
    `${args.limits.expiresAt ? `, expires ${args.limits.expiresAt.slice(0, 10)}` : every ? "" : ", expires in 7d"}`));
  console.log(chalk.dim("  Executes unattended on `xpay orders run` - irreversible swaps, guardrail caps apply."));
  console.log("");

  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      { type: "confirm", name: "go", message: "Create and activate this order?", default: false },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      return;
    }
  }

  let order: StockOrder;
  try {
    // A human confirmed this exact order at the terminal: activate it.
    order = await createStockOrder(dir, { ...args, approved: true });
  } catch (err) {
    fail((err as Error).message);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(order, null, 2) + "\n");
    return;
  }
  console.log(chalk.green(`✓ ${order.id} active - ${order.stock.symbol} (${order.stock.mint})`));
  console.log(chalk.dim(`  Runs when \`xpay orders run\` is called (cron, a scheduler, or your agent).`));
}

export function runOrdersList(opts: ProfileOpt & { all?: boolean; json?: boolean }): void {
  const orders = loadOrders(ordersDir(opts));
  const shown = opts.all
    ? orders
    : orders.filter((o) => !["completed", "cancelled", "expired"].includes(o.status));
  if (opts.json) {
    process.stdout.write(JSON.stringify(shown, null, 2) + "\n");
    return;
  }
  if (shown.length === 0) {
    console.log(chalk.dim(opts.all ? "No orders." : "No open orders. (--all shows finished ones)"));
    return;
  }
  console.log("");
  for (const o of shown) printOrder(o);
}

function printOrder(o: StockOrder): void {
  const what = `${o.side} ${o.side === "buy" ? `$${o.amount}` : `${o.amount}`} ${o.stock.symbol}`;
  const cadence = o.every ? `every ${o.every}` : "once";
  console.log(`  ${chalk.bold(o.id)}  ${statusLabel(o.status)}  ${chalk.white(what)} ${chalk.dim(cadence)}`);
  const caps = [
    o.limits.maxTotalUsd !== undefined ? `$${o.tradedUsd} of $${o.limits.maxTotalUsd}` : `$${o.tradedUsd} traded`,
    o.limits.maxFills !== undefined ? `${o.fills}/${o.limits.maxFills} fills` : `${o.fills} fills`,
    o.limits.expiresAt ? `expires ${o.limits.expiresAt.slice(0, 16).replace("T", " ")}Z` : undefined,
  ].filter(Boolean);
  console.log(chalk.dim(`      ${caps.join(" · ")}`));
  if (o.status === "active") {
    console.log(chalk.dim(`      next ${o.nextRunAt.slice(0, 16).replace("T", " ")}Z` +
      ` · premium ≤ ${o.conditions.maxPremiumPct ?? 2}%${o.conditions.marketOpenOnly ? " · market hours" : ""}`));
  }
  if (o.lastCheck && o.status === "active") console.log(chalk.yellow(`      waiting: ${o.lastCheck.detail}`));
  if (o.statusReason && o.status !== "active") console.log(chalk.dim(`      ${o.statusReason}`));
  if (o.status === "pending_approval") {
    console.log(chalk.cyan(`      created by an agent - approve with \`xpay orders approve ${o.id}\``));
  }
  console.log("");
}

function statusLabel(s: StockOrder["status"]): string {
  const pad = s.padEnd(16);
  if (s === "active") return chalk.green(pad);
  if (s === "pending_approval") return chalk.cyan(pad);
  if (s === "blocked" || s === "needs_review") return chalk.red(pad);
  if (s === "paused") return chalk.yellow(pad);
  return chalk.dim(pad);
}

type Action = "approve" | "cancel" | "pause" | "resume";

export async function runOrdersAction(
  action: Action,
  id: string,
  opts: ProfileOpt & { filled?: boolean },
): Promise<void> {
  const dir = ordersDir(opts);
  try {
    const o =
      action === "approve" ? await approveOrder(dir, id)
      : action === "cancel" ? await cancelOrder(dir, id)
      : action === "pause" ? await pauseOrder(dir, id)
      : await resumeOrder(dir, id, { countLastFill: opts.filled });
    console.log(chalk.green(`✓ ${o.id} is now ${o.status}`) + (o.statusReason ? chalk.dim(` (${o.statusReason})`) : ""));
  } catch (err) {
    fail((err as Error).message);
  }
}

export interface OrdersRunOptions extends ProfileOpt {
  passphrase?: string;
  dryRun?: boolean;
  json?: boolean;
}

export async function runOrdersRun(opts: OrdersRunOptions): Promise<void> {
  const dir = ordersDir(opts);
  // Nothing active → don't unlock (keeps a frequent cron cheap and silent).
  const active = loadOrders(dir).filter((o) => o.status === "active");
  if (active.length === 0) {
    if (opts.json) process.stdout.write(JSON.stringify({ ranAt: new Date().toISOString(), dryRun: Boolean(opts.dryRun), results: [], notDue: 0 }) + "\n");
    else console.log(chalk.dim("No active orders."));
    return;
  }

  const profile = await unlockActive(opts);
  // Approvals above the threshold can only be granted interactively (TTY or
  // Touch ID); a cron run gets them denied, which blocks that order.
  const xpay = createXPay({
    profile,
    guardrail: guardrailWithApproval(profile, { interactive: Boolean(process.stdin.isTTY) }),
  });

  let report: RunOrdersReport;
  try {
    report = await runDueOrders(dir, xpay, {
      dryRun: opts.dryRun,
      maxPerDay: readConfigFile(dir).guardrail?.maxPerDay,
    });
  } catch (err) {
    fail((err as Error).message);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  printReport(report);
}

function printReport(r: RunOrdersReport): void {
  const head = `${r.results.length} due order${r.results.length === 1 ? "" : "s"}, ${r.notDue} not due yet` + (r.dryRun ? chalk.yellow(" (dry run, nothing signed)") : "");
  console.log(chalk.dim(head));
  for (const e of r.results) {
    const color =
      e.outcome === "filled" || e.outcome === "would_fill" ? chalk.green
      : e.outcome === "waiting" ? chalk.yellow
      : e.outcome === "completed" || e.outcome === "expired" ? chalk.dim
      : chalk.red;
    console.log(`  ${chalk.bold(e.orderId)} ${color(e.outcome.padEnd(12))} ${e.side} ${e.symbol}: ${e.detail}`);
    if (e.txSig) console.log(chalk.dim(`      https://solscan.io/tx/${e.txSig}`));
  }
}
