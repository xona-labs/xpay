/**
 * `xpay token find <query>` — search Solana tokens by ticker, name, or mint.
 *
 * Read-only (Jupiter Token API) — does not load a profile or touch keys.
 */

import chalk from "chalk";
import { findTokens } from "../token/index.js";
import type { TokenInfo } from "../token/index.js";

export interface TokenFindCmdOptions {
  limit?: string;
  json?: boolean;
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
