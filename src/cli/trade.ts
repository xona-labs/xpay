/**
 * `xpay trade <amount> <fromToken> <toToken>` — trade tokens on Robinhood
 * Chain via Uniswap V3 (NOXA Fun launchpad). Buy a token with native ETH or
 * sell it back to ETH. Subject to the active guardrail, enforced before
 * signing. Shows a quote and asks for confirmation unless `-y`.
 *
 * `xpay trending` — list what's hot on Robinhood Chain (read-only, no wallet).
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { trendingTokens, newTokens } from "../trading/discovery.js";
import type { TradeQuote } from "../trading/index.js";
import { unlockActive, guardrailWithApproval } from "./common.js";

const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";

export interface TradeCmdOptions {
  profile?: string;
  passphrase?: string;
  slippageBps?: string;
  quoteOnly?: boolean;
  yes?: boolean;
}

export async function runTrade(
  amountRaw: string,
  fromToken: string,
  toToken: string,
  opts: TradeCmdOptions,
): Promise<void> {
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(chalk.red("✗ amount must be a positive number, e.g. `xpay trade 0.01 ETH CASHCAT`"));
    process.exit(1);
  }
  const slippageBps = opts.slippageBps ? Number(opts.slippageBps) : undefined;

  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile) });

  let quote: TradeQuote;
  try {
    quote = await xpay.tradeQuote({ amount, from: fromToken, to: toToken, slippageBps });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  printQuote(quote);

  if (opts.quoteOnly) return;

  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Execute this trade? (irreversible; caps: ${
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
    const result = await xpay.trade({ amount, from: fromToken, to: toToken, slippageBps });
    const elapsed = Date.now() - t0;
    console.log("");
    console.log(
      chalk.green(
        `✔ Traded ${result.inAmount} ${result.from.symbol} → ~${result.outAmount.toLocaleString()} ${result.to.symbol} in ${elapsed}ms`,
      ),
    );
    console.log(`  ${chalk.dim("tx:")}       ${result.txHash}`);
    console.log(`  ${chalk.dim("explorer:")} ${EXPLORER_TX}${result.txHash}`);
  } catch (err) {
    const e = err as Error;
    console.error("");
    console.error(chalk.red(`✗ ${e.message || String(e)}`));
    process.exit(1);
  }
}

function printQuote(quote: TradeQuote): void {
  const usd = quote.usdValue !== undefined ? ` (~$${quote.usdValue.toFixed(2)})` : "";
  const feePct = (quote.poolFee / 10_000).toFixed(2);
  console.log("");
  console.log(
    `  Trade ${chalk.bold(`${quote.inAmount} ${quote.from.symbol}`)}${usd} → ~${chalk.bold(
      `${fmtAmount(quote.outAmount)} ${quote.to.symbol}`,
    )}`,
  );
  console.log(
    chalk.dim(
      `  Robinhood Chain · Uniswap V3 · ${feePct}% pool · slippage ${quote.slippageBps} bps · ` +
        `min out ${humanMinOut(quote)} ${quote.to.symbol}`,
    ),
  );
  if (quote.unverified) {
    console.log("");
    console.log(chalk.yellow(`  ⚠ ${quote.to.symbol} is NOT a confirmed NOXA Fun launch.`));
    console.log(chalk.yellow("    Verify the contract address — memecoin tickers are not unique and can be spoofed."));
  }
  if (quote.restriction) {
    console.log("");
    console.log(
      chalk.yellow(
        "  ⚠ This trade is close to the token's NOXA transfer cap (per-tx / max-wallet). " +
          "A larger buy may be rejected.",
      ),
    );
  }
  console.log("");
}

/** Adaptive number formatting — thousands separators for big amounts, enough
 *  significant digits for small ones (memecoin token counts vs tiny ETH sums). */
function fmtAmount(n: number): string {
  if (n === 0) return "0";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  // Sub-1: keep ~4 significant figures so tiny ETH outputs aren't rounded away.
  const digits = Math.min(18, Math.max(4, -Math.floor(Math.log10(n)) + 3));
  return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function humanMinOut(quote: TradeQuote): string {
  const decimals = quote.to.decimals;
  const s = BigInt(quote.minOutAtoms).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export interface TrendingCmdOptions {
  limit?: string;
  new?: boolean;
}

export async function runTrending(opts: TrendingCmdOptions): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : 10;
  try {
    const tokens = opts.new ? await newTokens({ limit }) : await trendingTokens({ limit });
    const heading = opts.new ? "Newest" : "Trending";
    console.log("");
    console.log(chalk.bold(`  ${heading} tokens on Robinhood Chain`));
    console.log("");
    if (tokens.length === 0) {
      console.log(chalk.dim("  (none returned)"));
      return;
    }
    for (const t of tokens) {
      const price = t.priceUsd !== undefined ? `$${formatPrice(t.priceUsd)}` : "—";
      const vol = t.volume24hUsd !== undefined ? `$${abbrev(t.volume24hUsd)}` : "—";
      const chg =
        t.priceChange24hPct !== undefined
          ? (t.priceChange24hPct >= 0 ? chalk.green : chalk.red)(`${t.priceChange24hPct.toFixed(1)}%`)
          : "—";
      const flag = t.poolIsV4 ? chalk.dim(" [v4 pool — not tradeable via xpay yet]") : "";
      console.log(`  ${chalk.bold(t.symbol.padEnd(12))} ${price.padEnd(14)} 24h ${chg.padEnd(16)} vol ${vol}`);
      console.log(`  ${chalk.dim(t.address)}${flag}`);
    }
    console.log("");
    console.log(chalk.dim("  Trade one:  xpay trade 0.01 ETH <address>"));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}

function formatPrice(p: number): string {
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toExponential(2);
}

function abbrev(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}
