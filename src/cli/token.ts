/**
 * `xpay token find <query>` - search Solana tokens by ticker, name, or mint.
 *
 * Read-only (Jupiter Token API) - does not load a profile or touch keys.
 */

import chalk from "chalk";
import { findTokens } from "../token/index.js";
import type { TokenInfo } from "../token/index.js";
import { findRwaTokens, type RwaToken, type RwaCategory } from "../token/rwa.js";
import { findStocks, type StockQuote } from "../token/stock.js";

export interface TokenFindCmdOptions {
  limit?: string;
  json?: boolean;
}

export interface TokenRwaCmdOptions {
  category?: string;
  limit?: string;
  unverified?: boolean;
  json?: boolean;
}

export async function runTokenRwa(query: string | undefined, opts: TokenRwaCmdOptions): Promise<void> {
  if (opts.category && opts.category !== "stocks" && opts.category !== "treasuries") {
    console.error(chalk.red(`✗ --category must be "stocks" or "treasuries", got "${opts.category}"`));
    process.exit(1);
  }

  const t0 = Date.now();
  let results: RwaToken[];
  try {
    results = await findRwaTokens({
      query,
      category: opts.category as RwaCategory | undefined,
      limit: opts.limit ? Number(opts.limit) : 20,
      includeUnverified: opts.unverified,
    });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
  const elapsed = Date.now() - t0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow(`No tradable RWA tokens found${query ? ` for "${query}"` : ""}.`));
    return;
  }

  console.log("");
  console.log(chalk.dim(`${results.length} RWA token${results.length === 1 ? "" : "s"} on Solana${query ? ` for "${query}"` : ""} (${elapsed}ms)`));
  console.log("");

  for (let i = 0; i < results.length; i++) {
    const t = results[i]!;
    const badge = t.verified ? chalk.green("✓") : chalk.yellow("⚠ unverified");
    const price = t.usdPrice !== undefined ? formatPrice(t.usdPrice) : chalk.dim("?");
    const liq = t.liquidity !== undefined ? `liq ${formatCompact(t.liquidity)}` : "";
    console.log(
      `  ${chalk.bold(String(i + 1).padStart(2) + ".")} ${chalk.bold(t.symbol.padEnd(10))} ${price.padEnd(14)} ${badge}  ${chalk.dim(`${t.issuer} · ${t.category}${liq ? ` · ${liq}` : ""}`)}`,
    );
    console.log(`      ${chalk.white(t.name)}`);
    console.log(`      ${chalk.dim(t.mint)}`);
    console.log("");
  }
  console.log(chalk.dim("Tokenized stocks track the underlying but are issuer IOUs, not brokerage shares."));
  console.log(chalk.dim("Use `xpay swap <amount> USDC <symbol-or-mint>` to swap into one."));
}

export interface TokenStockCmdOptions {
  limit?: string;
  json?: boolean;
}

export async function runTokenStock(query: string | undefined, opts: TokenStockCmdOptions): Promise<void> {
  const t0 = Date.now();
  let result;
  try {
    result = await findStocks({ query, limit: opts.limit ? Number(opts.limit) : 20 });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
  const elapsed = Date.now() - t0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const { stocks, marketStatus, note } = result;
  if (stocks.length === 0) {
    console.log(chalk.yellow(`No tokenized stocks found${query ? ` for "${query}"` : ""}.`));
    return;
  }

  console.log("");
  console.log(
    chalk.dim(
      `${stocks.length} tokenized stock${stocks.length === 1 ? "" : "s"} on Solana` +
        `${query ? ` for "${query}"` : ""} · US market ${marketStatus} (${elapsed}ms)`,
    ),
  );
  if (note) console.log(chalk.yellow(`  ${note}`));
  console.log("");

  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i]!;
    const badge = s.verified ? chalk.green("✓") : chalk.yellow("⚠ unverified");
    const price = s.onchainPrice !== undefined ? formatPrice(s.onchainPrice) : chalk.dim("?");
    const prem = formatPremium(s);
    const chg =
      s.priceChange24hPct !== undefined
        ? (s.priceChange24hPct >= 0 ? chalk.green : chalk.red)(
            `${s.priceChange24hPct >= 0 ? "+" : ""}${s.priceChange24hPct.toFixed(2)}% 24h`,
          )
        : "";
    const liq = s.liquidityUsd !== undefined ? `liq ${formatCompact(s.liquidityUsd)}` : "";
    console.log(
      `  ${chalk.bold(String(i + 1).padStart(2) + ".")} ${chalk.bold(s.symbol.padEnd(10))} ${price.padEnd(14)} ${badge}  ${chalk.dim(`${s.issuer}${liq ? ` · ${liq}` : ""}`)}`,
    );
    console.log(`      ${chalk.white(s.name)}${prem ? `  ${prem}` : ""}${chg ? `  ${chg}` : ""}`);
    console.log(`      ${chalk.dim(s.mint)}`);
    console.log("");
  }
  console.log(chalk.dim("Tokenized stocks are issuer IOUs tracking the underlying, not brokerage shares."));
  console.log(chalk.dim("Premiums widen while the US market is closed; check liquidity before acting on one."));
  console.log(chalk.dim("Use `xpay swap <amount> USDC <symbol-or-mint>` to swap into one."));
}

function formatPremium(s: StockQuote): string {
  if (s.premiumDiscountPct === undefined || s.underlyingPrice === undefined) return "";
  const pct = s.premiumDiscountPct;
  const label = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs $${s.underlyingPrice.toFixed(2)} underlying`;
  if (Math.abs(pct) >= 1) return chalk.yellow(label);
  return chalk.dim(label);
}

export async function runTokenFind(query: string, opts: TokenFindCmdOptions): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : 10;

  const t0 = Date.now();
  let results: TokenInfo[];
  try {
    results = await findTokens(query, { limit });
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
  const elapsed = Date.now() - t0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow(`No tokens found for "${query}".`));
    return;
  }

  console.log("");
  console.log(chalk.dim(`${results.length} token${results.length === 1 ? "" : "s"} for "${query}" (${elapsed}ms)`));
  console.log("");

  for (let i = 0; i < results.length; i++) {
    const t = results[i]!;
    const badge = t.verified ? chalk.green("✓ verified") : chalk.yellow("⚠ unverified");
    const price = t.usdPrice !== undefined ? formatPrice(t.usdPrice) : chalk.dim("?");
    const mcap = t.mcap !== undefined ? `mcap ${formatCompact(t.mcap)}` : "";
    const liq = t.liquidity !== undefined ? `liq ${formatCompact(t.liquidity)}` : "";

    console.log(
      `  ${chalk.bold(String(i + 1).padStart(2) + ".")} ${chalk.bold(t.symbol.padEnd(10))} ${price.padEnd(14)} ${badge}  ${chalk.dim([mcap, liq].filter(Boolean).join(", "))}`,
    );
    console.log(`      ${chalk.white(t.name)}`);
    console.log(`      ${chalk.dim(t.mint)}`);
    console.log("");
  }
  console.log(chalk.dim("Use `xpay swap <amount> <from> <symbol-or-mint>` to swap into one."));
}

function formatPrice(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toPrecision(4)}`;
}

function formatCompact(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
