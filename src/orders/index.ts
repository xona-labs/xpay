/**
 * Standing stock orders: recurring buys ("$25 of SPYx every Monday") and
 * conditional one-shots ("buy $100 of NVDAx once its premium is under 0.5%").
 *
 * Orders live in the wallet profile (`<profile>/orders.json`), not in any
 * agent framework, so whichever framework created an order, the same
 * {@link runDueOrders} executes it. Something external triggers runs: a
 * scheduler, cron, the CLI (`xpay orders run`), or an agent tool call. Each
 * run is stateless and idempotent - it re-checks every due order against live
 * prices and trades only what qualifies.
 *
 * Safety model (runs are often unattended):
 *  - Every order is finite: a total USD budget and/or a fill count, and
 *    one-shots expire (default 7 days).
 *  - Orders created by an agent start `pending_approval` and only a human
 *    (the CLI) can approve them, so a prompt-injected agent cannot schedule
 *    trades that execute overnight.
 *  - The profile's `maxPerDay` is enforced across runs from the persisted
 *    fill log (the in-memory guardrail resets every process).
 *  - A fill that may have landed but was not confirmed parks the order in
 *    `needs_review` instead of retrying, so a run never double-buys.
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { XPay } from "../index.js";
import { GuardrailError } from "../guardrail/index.js";
import { SwapSubmitError } from "../swap/index.js";
import {
  USDC_MINT,
  prepareStockTrade,
  resolveStock,
  usEquityMarketStatus,
  type StockTradePlan,
} from "../token/stock.js";

export type OrderStatus =
  | "pending_approval"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired"
  /** Needs a user decision before it can run again (e.g. guardrail approval). */
  | "blocked"
  /** A fill may have landed unconfirmed - verify on-chain, then resume. */
  | "needs_review";

export type OrderOrigin = "cli" | "agent" | "sdk";

export interface OrderConditions {
  /** Max adverse premium/discount vs the underlying, %. Default: the stock-trade default (2%). */
  maxPremiumPct?: number;
  /** Min on-chain liquidity, USD. Default: the stock-trade default ($50k). */
  minLiquidityUsd?: number;
  /** Only fill while the US market is open. */
  marketOpenOnly?: boolean;
  slippageBps?: number;
}

export interface OrderLimits {
  /** Total USD this order may trade across all fills. */
  maxTotalUsd?: number;
  /** Max number of fills. One-shot orders are always 1. */
  maxFills?: number;
  /** ISO time after which the order stops. */
  expiresAt?: string;
}

export interface OrderEvent {
  at: string;
  outcome: "filled" | "failed" | "status";
  detail: string;
  usd?: number;
  txSig?: string;
}

export interface StockOrder {
  id: string;
  createdAt: string;
  createdBy: OrderOrigin;
  status: OrderStatus;
  /** Why the order is in its current status (blocked/needs_review/completed...). */
  statusReason?: string;
  side: "buy" | "sell";
  /** Pinned at creation so later runs can't re-resolve to another issuer. */
  stock: { input: string; mint: string; symbol: string };
  /** Per fill: USDC for buys, stock tokens for sells. */
  amount: number;
  /** Interval spec ("1d", "1w", "12h", "1m", "daily", "weekly", "monthly"). Absent = one-shot. */
  every?: string;
  conditions: OrderConditions;
  limits: OrderLimits;
  nextRunAt: string;
  fills: number;
  /** USD traded so far (USDC spent for buys, proceeds estimate for sells). */
  tradedUsd: number;
  /** Set while a fill is being submitted; a leftover one means a crashed run. */
  inflight?: { startedAt: string };
  /** Most recent run's verdict when the order did not fill (not appended to history). */
  lastCheck?: { at: string; detail: string };
  /** Fills, failures, and status changes; newest last, capped. */
  history: OrderEvent[];
}

interface OrdersFile {
  version: 1;
  orders: StockOrder[];
}

export interface CreateStockOrderArgs {
  side: "buy" | "sell";
  /** Ticker (AAPL), tokenized symbol (AAPLx), or mint. */
  stock: string;
  amount: number;
  every?: string;
  /** ISO time or Date for the first fill attempt. Default: now. */
  startAt?: string | Date;
  conditions?: OrderConditions;
  limits?: OrderLimits;
  createdBy?: OrderOrigin;
  /**
   * Activate immediately. Only pass true when a human confirmed this exact
   * order; agent-originated orders should stay pending for CLI approval.
   */
  approved?: boolean;
}

export interface RunOrdersOptions {
  /** Evaluate and quote, but never sign or submit. */
  dryRun?: boolean;
  /** Profile daily cap (USD), enforced across runs from the fill log. */
  maxPerDay?: number;
  now?: Date;
  /** Delay between evaluating due orders (rate-limit courtesy). Default 1500ms. */
  paceMs?: number;
}

export type RunOutcome = "filled" | "would_fill" | "waiting" | "completed" | "expired" | "blocked" | "needs_review" | "failed";

export interface RunResultEntry {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  outcome: RunOutcome;
  detail: string;
  usd?: number;
  txSig?: string;
}

export interface RunOrdersReport {
  ranAt: string;
  dryRun: boolean;
  /** Orders that were due and evaluated this run. */
  results: RunResultEntry[];
  /** Active orders not yet due. */
  notDue: number;
}

const FILE = "orders.json";
const LOCK = "orders.lock";
/** A lock older than this is from a crashed run. */
const LOCK_STALE_MS = 15 * 60 * 1000;
const HISTORY_CAP = 50;
const ONE_SHOT_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────────

export function loadOrders(dir: string): StockOrder[] {
  const file = join(dir, FILE);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8")) as OrdersFile;
  return data.orders ?? [];
}

function saveOrders(dir: string, orders: StockOrder[]): void {
  const file = join(dir, FILE);
  const tmp = `${file}.tmp`;
  const blob: OrdersFile = { version: 1, orders };
  writeFileSync(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Run `fn` holding the profile's orders lock; throws if another run holds it. */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, LOCK);
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < LOCK_STALE_MS) {
      throw new Error("xpay.orders: another orders run is in progress (orders.lock) - try again shortly");
    }
    unlinkSync(lock);
    fd = openSync(lock, "wx");
  }
  try {
    writeFileSync(fd, String(process.pid));
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // Already gone.
    }
  }
}

/** Load, mutate, save under the lock. `persist: false` evaluates on a throwaway copy. */
async function mutate<T>(
  dir: string,
  fn: (orders: StockOrder[]) => T | Promise<T>,
  persist = true,
): Promise<T> {
  return withLock(dir, async () => {
    const orders = loadOrders(dir);
    const out = await fn(orders);
    if (persist) saveOrders(dir, orders);
    return out;
  });
}

// ── Intervals ────────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = { hourly: "1h", daily: "1d", weekly: "1w", monthly: "1m" };

/** Validate an interval spec; returns the normalized form ("1d", "2w", ...). */
export function parseEvery(spec: string): string {
  const s = (ALIASES[spec.trim().toLowerCase()] ?? spec.trim().toLowerCase()).replace(/\s+/g, "");
  const m = /^(\d+)(h|d|w|m)$/.exec(s);
  if (!m || Number(m[1]) <= 0) {
    throw new Error(`xpay.orders: invalid interval "${spec}" - use e.g. 12h, 1d, 1w, 1m, daily, weekly, monthly`);
  }
  if (m[2] === "h" && Number(m[1]) * 3600_000 < MIN_INTERVAL_MS) {
    throw new Error("xpay.orders: interval must be at least 1h");
  }
  return s;
}

/** `from` advanced by one interval. Months are calendar months. */
function addInterval(from: Date, spec: string): Date {
  const m = /^(\d+)(h|d|w|m)$/.exec(spec)!;
  const n = Number(m[1]);
  const d = new Date(from);
  if (m[2] === "h") d.setTime(d.getTime() + n * 3600_000);
  else if (m[2] === "d") d.setTime(d.getTime() + n * 86_400_000);
  else if (m[2] === "w") d.setTime(d.getTime() + n * 7 * 86_400_000);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

/**
 * Next slot strictly after `now`, keeping the original cadence. Missed
 * periods are skipped, never caught up with multiple fills.
 */
function nextSlot(prev: Date, spec: string, now: Date): Date {
  let next = addInterval(prev, spec);
  while (next <= now) next = addInterval(next, spec);
  return next;
}

// ── Create / manage ──────────────────────────────────────────────────────

export async function createStockOrder(dir: string, args: CreateStockOrderArgs): Promise<StockOrder> {
  if (args.side !== "buy" && args.side !== "sell") {
    throw new Error(`xpay.orders: side must be "buy" or "sell"`);
  }
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    throw new Error("xpay.orders: amount must be a positive number");
  }
  const every = args.every ? parseEvery(args.every) : undefined;
  const limits: OrderLimits = { ...args.limits };

  if (every) {
    if (limits.maxTotalUsd === undefined && limits.maxFills === undefined) {
      throw new Error(
        "xpay.orders: a recurring order needs a cap - set maxTotalUsd (total budget) and/or maxFills",
      );
    }
  } else {
    limits.maxFills = 1;
  }
  if (limits.maxTotalUsd !== undefined && !(limits.maxTotalUsd > 0)) {
    throw new Error("xpay.orders: maxTotalUsd must be positive");
  }
  if (limits.maxFills !== undefined && !(Number.isInteger(limits.maxFills) && limits.maxFills > 0)) {
    throw new Error("xpay.orders: maxFills must be a positive integer");
  }
  if (args.side === "buy" && limits.maxTotalUsd !== undefined && limits.maxTotalUsd < args.amount) {
    throw new Error(`xpay.orders: maxTotalUsd ($${limits.maxTotalUsd}) is below one fill ($${args.amount})`);
  }

  const now = new Date();
  const start = args.startAt ? new Date(args.startAt) : now;
  if (Number.isNaN(start.getTime())) throw new Error("xpay.orders: invalid startAt");
  if (!every && !limits.expiresAt) {
    limits.expiresAt = new Date(start.getTime() + ONE_SHOT_DEFAULT_TTL_MS).toISOString();
  }
  if (limits.expiresAt && Number.isNaN(new Date(limits.expiresAt).getTime())) {
    throw new Error("xpay.orders: invalid expiresAt");
  }

  // Pin the exact token now. Same resolution + verification as a direct trade.
  const quote = await resolveStock(args.stock);
  if (!quote.verified) {
    throw new Error(`xpay.orders: ${quote.symbol} (${quote.mint}) is not Jupiter-verified - refusing to schedule it`);
  }

  const createdBy = args.createdBy ?? "sdk";
  const order: StockOrder = {
    id: `ord_${randomBytes(4).toString("hex")}`,
    createdAt: now.toISOString(),
    createdBy,
    status: args.approved ? "active" : "pending_approval",
    side: args.side,
    stock: { input: args.stock, mint: quote.mint, symbol: quote.symbol },
    amount: args.amount,
    every,
    conditions: { ...args.conditions },
    limits,
    nextRunAt: start.toISOString(),
    fills: 0,
    tradedUsd: 0,
    history: [{ at: now.toISOString(), outcome: "status", detail: `created by ${createdBy}` }],
  };

  await mutate(dir, (orders) => {
    orders.push(order);
  });
  return order;
}

function findOrder(orders: StockOrder[], id: string): StockOrder {
  const o = orders.find((x) => x.id === id);
  if (!o) throw new Error(`xpay.orders: no order "${id}"`);
  return o;
}

function setStatus(o: StockOrder, status: OrderStatus, detail: string, at = new Date()): void {
  o.status = status;
  o.statusReason = detail;
  pushHistory(o, { at: at.toISOString(), outcome: "status", detail: `${status}: ${detail}` });
}

function pushHistory(o: StockOrder, e: OrderEvent): void {
  o.history.push(e);
  if (o.history.length > HISTORY_CAP) o.history.splice(0, o.history.length - HISTORY_CAP);
}

const TERMINAL: OrderStatus[] = ["completed", "cancelled", "expired"];

/** Activate a pending order. Call only on a human's explicit say-so. */
export async function approveOrder(dir: string, id: string): Promise<StockOrder> {
  return mutate(dir, (orders) => {
    const o = findOrder(orders, id);
    if (o.status !== "pending_approval") {
      throw new Error(`xpay.orders: ${id} is ${o.status}, not pending approval`);
    }
    setStatus(o, "active", "approved");
    return o;
  });
}

export async function cancelOrder(dir: string, id: string): Promise<StockOrder> {
  return mutate(dir, (orders) => {
    const o = findOrder(orders, id);
    if (TERMINAL.includes(o.status)) throw new Error(`xpay.orders: ${id} is already ${o.status}`);
    setStatus(o, "cancelled", "cancelled by user");
    delete o.inflight;
    return o;
  });
}

export async function pauseOrder(dir: string, id: string): Promise<StockOrder> {
  return mutate(dir, (orders) => {
    const o = findOrder(orders, id);
    if (o.status !== "active") throw new Error(`xpay.orders: ${id} is ${o.status}, only active orders pause`);
    setStatus(o, "paused", "paused by user");
    return o;
  });
}

/**
 * Resume a paused, blocked, or needs_review order. For needs_review, the
 * caller has verified on-chain whether the last fill landed; pass
 * `countLastFill` when it did so budgets and schedules stay correct.
 */
export async function resumeOrder(
  dir: string,
  id: string,
  opts: { countLastFill?: boolean } = {},
): Promise<StockOrder> {
  return mutate(dir, (orders) => {
    const o = findOrder(orders, id);
    if (!["paused", "blocked", "needs_review"].includes(o.status)) {
      throw new Error(`xpay.orders: ${id} is ${o.status} - only paused, blocked, or needs_review orders resume`);
    }
    const now = new Date();
    if (o.status === "needs_review" && opts.countLastFill) {
      recordFill(o, o.side === "buy" ? o.amount : 0, undefined, "fill confirmed manually", now);
    }
    delete o.inflight;
    setStatus(o, "active", "resumed by user", now);
    settle(o, now);
    return o;
  });
}

// ── Run ──────────────────────────────────────────────────────────────────

function recordFill(o: StockOrder, usd: number, txSig: string | undefined, detail: string, now: Date): void {
  o.fills += 1;
  o.tradedUsd = round2(o.tradedUsd + usd);
  pushHistory(o, { at: now.toISOString(), outcome: "filled", detail, usd, txSig });
  if (o.every) o.nextRunAt = nextSlot(new Date(o.nextRunAt), o.every, now).toISOString();
}

/** Close out an order whose limits are used up. Returns true if it closed. */
function settle(o: StockOrder, now: Date): boolean {
  if (o.limits.maxFills !== undefined && o.fills >= o.limits.maxFills) {
    setStatus(o, "completed", `${o.fills} fill${o.fills === 1 ? "" : "s"} done`, now);
    return true;
  }
  if (
    o.side === "buy" &&
    o.limits.maxTotalUsd !== undefined &&
    o.tradedUsd + o.amount > o.limits.maxTotalUsd + 1e-9
  ) {
    setStatus(o, "completed", `budget used ($${o.tradedUsd} of $${o.limits.maxTotalUsd})`, now);
    return true;
  }
  if (o.side === "sell" && o.limits.maxTotalUsd !== undefined && o.tradedUsd >= o.limits.maxTotalUsd) {
    setStatus(o, "completed", `sold $${o.tradedUsd} (cap $${o.limits.maxTotalUsd})`, now);
    return true;
  }
  if (o.limits.expiresAt && new Date(o.limits.expiresAt) <= now) {
    setStatus(o, "expired", `expired ${o.limits.expiresAt}`, now);
    return true;
  }
  return false;
}

/** USD filled across all orders in the 24h before `now`. */
function filledLast24h(orders: StockOrder[], now: Date): number {
  const since = now.getTime() - 86_400_000;
  let sum = 0;
  for (const o of orders) {
    for (const e of o.history) {
      if (e.outcome === "filled" && e.usd && new Date(e.at).getTime() >= since) sum += e.usd;
    }
  }
  return sum;
}

/**
 * Execute every due, active order whose conditions hold right now. Safe to
 * call as often as you like - orders that aren't due or don't qualify are
 * left untouched (apart from `lastCheck`).
 */
export async function runDueOrders(
  dir: string,
  xpay: XPay,
  opts: RunOrdersOptions = {},
): Promise<RunOrdersReport> {
  const now = opts.now ?? new Date();
  const dryRun = Boolean(opts.dryRun);

  return mutate(dir, async (orders) => {
    const results: RunResultEntry[] = [];
    let notDue = 0;
    let evaluated = 0;

    for (const o of orders) {
      if (o.status !== "active") continue;
      const entry = (outcome: RunOutcome, detail: string, extra: Partial<RunResultEntry> = {}) => {
        results.push({ orderId: o.id, symbol: o.stock.symbol, side: o.side, outcome, detail, ...extra });
      };

      // A leftover inflight marker means a previous run died mid-submit.
      if (o.inflight) {
        setStatus(o, "needs_review", `a fill started ${o.inflight.startedAt} was never confirmed - check the wallet's recent transactions, then resume`, now);
        entry("needs_review", o.statusReason!);
        continue;
      }
      if (settle(o, now)) {
        entry((o.status as OrderStatus) === "expired" ? "expired" : "completed", o.statusReason!);
        continue;
      }
      if (new Date(o.nextRunAt) > now) {
        notDue++;
        continue;
      }

      const wait = (detail: string) => {
        o.lastCheck = { at: now.toISOString(), detail };
        entry("waiting", detail);
      };

      if (o.conditions.marketOpenOnly && usEquityMarketStatus(now) !== "open") {
        wait(`US market is ${usEquityMarketStatus(now).replace("_", " ")} (order is market-hours only)`);
        continue;
      }

      // Each evaluation is several keyless Jupiter calls; space orders out
      // so a run with many due orders doesn't trip the shared rate limit.
      if (evaluated++ > 0) await new Promise((res) => setTimeout(res, opts.paceMs ?? 1_500));

      let plan: StockTradePlan;
      try {
        plan = await prepareStockTrade({
          stock: o.stock.mint,
          side: o.side,
          maxPremiumPct: o.conditions.maxPremiumPct,
          minLiquidityUsd: o.conditions.minLiquidityUsd,
        });
      } catch (err) {
        // Premium/liquidity out of bounds (or a price API hiccup): try again next run.
        wait((err as Error).message.replace(/^xpay\.stock: /, ""));
        continue;
      }

      const estUsd = o.side === "buy" ? o.amount : o.amount * (plan.stock.onchainPrice ?? 0);
      if (opts.maxPerDay !== undefined) {
        const used = filledLast24h(orders, now);
        if (used + estUsd > opts.maxPerDay + 1e-9) {
          wait(`daily cap: $${round2(used)} filled in the last 24h + ~$${round2(estUsd)} would exceed maxPerDay $${opts.maxPerDay}`);
          continue;
        }
      }

      const swapArgs = {
        amount: o.amount,
        from: o.side === "buy" ? USDC_MINT : o.stock.mint,
        to: o.side === "buy" ? o.stock.mint : USDC_MINT,
        slippageBps: o.conditions.slippageBps,
      };

      if (dryRun) {
        try {
          const q = await xpay.swapQuote(swapArgs);
          const px = plan.stock.premiumDiscountPct;
          entry(
            "would_fill",
            `${o.side} ${q.inAmount} ${q.from.symbol} → ~${round4(q.outAmount)} ${q.to.symbol}` +
              (px !== undefined ? ` (premium ${px.toFixed(2)}%)` : ""),
            { usd: round2(q.usdValue ?? estUsd) },
          );
        } catch (err) {
          entry("failed", (err as Error).message);
        }
        continue;
      }

      // Persist the inflight marker BEFORE signing: if this process dies
      // mid-submit, the next run parks the order instead of buying again.
      o.inflight = { startedAt: now.toISOString() };
      saveOrders(dir, orders);

      try {
        const res = await xpay.swap(swapArgs);
        delete o.inflight;
        const usd = round2(o.side === "buy" ? res.totalInAmount ?? o.amount : res.totalOutAmount ?? estUsd);
        const detail = `${o.side} ${res.totalInAmount ?? res.inAmount} ${res.from.symbol} → ${round4(res.totalOutAmount ?? res.outAmount)} ${res.to.symbol}`;
        recordFill(o, usd, res.txSig, detail, now);
        delete o.lastCheck;
        entry("filled", detail, { usd, txSig: res.txSig });
        settle(o, now);
      } catch (err) {
        const msg = (err as Error).message;
        if (err instanceof SwapSubmitError && err.maybeLanded) {
          // Keep the inflight marker's meaning: don't know, don't retry.
          delete o.inflight;
          setStatus(o, "needs_review", `${msg} - verify on-chain, then resume (with --filled if it landed)`, now);
          entry("needs_review", o.statusReason!, { txSig: err.txSig });
        } else if (err instanceof GuardrailError) {
          // Deterministic (per-tx cap, approval threshold): retrying won't help.
          delete o.inflight;
          setStatus(o, "blocked", `guardrail: ${msg}`, now);
          entry("blocked", o.statusReason!);
        } else {
          // Failed before anything was submitted (quote, signing, Jupiter
          // rejected without a signature) - safe to try again next run.
          delete o.inflight;
          pushHistory(o, { at: now.toISOString(), outcome: "failed", detail: msg });
          entry("failed", msg);
        }
      }
    }

    return { ranAt: now.toISOString(), dryRun, results, notDue };
  }, !dryRun);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
