/**
 * `xpay discover <query>` — search the agentic-commerce catalog.
 *
 * Read-only — does not load a profile or touch keys.
 */

import chalk from "chalk";
import { discover } from "../discover/index.js";
import { formatUsd, shortAddress } from "./common.js";
import type { Resource } from "../types.js";

export interface DiscoverCmdOptions {
  limit?: string;
  network?: string;
  json?: boolean;
}

export async function runDiscover(query: string | undefined, opts: DiscoverCmdOptions): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : 10;
  const networks = opts.network ? [opts.network] : undefined;

  const t0 = Date.now();
  const results = await discover({ query, limit, networks });
  const elapsed = Date.now() - t0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow(`No services found${query ? ` for "${query}"` : ""}.`));
    console.log(chalk.dim(`Tip: try broader terms, or omit --network.`));
    return;
  }

  console.log("");
  console.log(
    chalk.dim(
      `${results.length} result${results.length === 1 ? "" : "s"}` +
        (query ? ` for "${query}"` : "") +
        ` (${elapsed}ms)`,
    ),
  );
  console.log("");

  for (let i = 0; i < results.length; i++) {
    printResource(results[i]!, i + 1);
  }
  console.log("");
  console.log(chalk.dim(`Use \`xpay pay <url>\` to call one.`));
}

function printResource(r: Resource, index: number): void {
  const opt = r.accepts[0];
  const price = opt?.amount ? formatUsd(Number(opt.amount) / 1_000_000) : chalk.dim("?");
  const net = chalk.cyan(normalizeNetwork(opt?.network).padEnd(9));
  const method = chalk.dim(r.method.padEnd(6));
  const host = safeHost(r.resource);

  console.log(`  ${chalk.bold(String(index).padStart(2) + ".")} ${price}  ${net} ${method} ${chalk.white(host)}`);
  console.log(`      ${chalk.dim(r.resource)}`);
  if (opt?.payTo) {
    console.log(
      `      ${chalk.dim("→ pay")} ${chalk.dim(shortAddress(opt.payTo, 6, 6))} ${chalk.dim(`(${opt.asset.slice(0, 12)}…)`)}`,
    );
  }
  console.log("");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function normalizeNetwork(raw: string | undefined): string {
  if (!raw) return "?";
  if (raw === "eip155:8453") return "base";
  if (raw === "eip155:1") return "ethereum";
  if (raw === "eip155:42161") return "arbitrum";
  if (raw.startsWith("solana")) return "solana";
  return raw;
}
