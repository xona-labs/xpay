/**
 * `xpay sana link|unlink|status` — manage the Sana agent card integration.
 *
 * Once linked, the MCP server automatically registers sana_* tools so your
 * agent can check the card balance, top it up, view transactions, etc.
 *
 * Usage:
 *   xpay sana link sana_live_...     # save API key to active profile
 *   xpay sana unlink                 # remove the key
 *   xpay sana status                 # show whether a key is configured
 */

import chalk from "chalk";
import { setSanaApiKey, clearSanaApiKey, readProfileConfig } from "../profile/index.js";
import { SanaClient } from "../sana/client.js";
import { getActiveProfile } from "./accounts.js";

// ─── Resolve API key ───────────────────────────────────────────────────────

function resolveSanaKey(opts: { profile?: string }): string {
  const name = opts.profile ?? getActiveProfile();
  const config = readProfileConfig(name);
  const key = config.sana?.apiKey ?? process.env.SANABOT_API_KEY;
  if (!key) {
    console.error(chalk.red("✗ No Sana API key found."));
    console.error(chalk.dim("  Run: xpay sana link sana_live_..."));
    process.exit(1);
  }
  return key;
}

// ─── Live tool runners ────────────────────────────────────────────────────

export async function runSanaCard(opts: { profile?: string }): Promise<void> {
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("get_card");
  console.log(JSON.stringify(result, null, 2));
}

export async function runSanaCardBalance(opts: { profile?: string }): Promise<void> {
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("get_card_balance");
  console.log(JSON.stringify(result, null, 2));
}

export async function runSanaCardDeposit(amount: string, opts: { profile?: string }): Promise<void> {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(chalk.red(`✗ Invalid amount "${amount}". Must be a positive number.`));
    process.exit(1);
  }
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("card_deposit", { amount: n });
  console.log(JSON.stringify(result, null, 2));
}

export async function runSanaCardTransactions(opts: { profile?: string; limit?: string }): Promise<void> {
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("get_transaction_history", {
    context: "card",
    ...(opts.limit ? { limit: Number(opts.limit) } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runSanaPortfolio(opts: { profile?: string }): Promise<void> {
  const client = new SanaClient(resolveSanaKey(opts));
  const [netWorth, holdings] = await Promise.all([
    client.callTool("get_net_worth"),
    client.callTool("get_holdings"),
  ]);
  console.log(JSON.stringify({ netWorth, holdings }, null, 2));
}

export async function runSanaPrice(token: string, opts: { profile?: string }): Promise<void> {
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("get_price", { token: token.toUpperCase() });
  console.log(JSON.stringify(result, null, 2));
}

export async function runSanaSwap(
  fromToken: string,
  toToken: string,
  amount: string,
  opts: { profile?: string },
): Promise<void> {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(chalk.red(`✗ Invalid amount "${amount}".`));
    process.exit(1);
  }
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("wallet_swap", {
    fromToken: fromToken.toUpperCase(),
    toToken: toToken.toUpperCase(),
    amount: n,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runSanaNotifications(opts: { profile?: string }): Promise<void> {
  const client = new SanaClient(resolveSanaKey(opts));
  const result = await client.callTool("get_notifications");
  console.log(JSON.stringify(result, null, 2));
}

export function runSanaLink(apiKey: string, opts: { profile?: string }): void {
  if (!apiKey.startsWith("sana_")) {
    console.error(chalk.red("✗ That doesn't look like a Sana API key (expected sana_live_...)."));
    process.exit(1);
  }

  const name = opts.profile ?? getActiveProfile();
  setSanaApiKey(name, apiKey);

  console.log(chalk.green(`✔ Sana key linked to profile "${name}".`));
  console.log(chalk.dim("  Restart your MCP client — sana_* tools will appear automatically."));
  console.log("");
  console.log(`  ${chalk.bold("sana_card")}              Card status & metadata`);
  console.log(`  ${chalk.bold("sana_card_balance")}      Available spending power`);
  console.log(`  ${chalk.bold("sana_card_deposit")}      Top up the card with USDC`);
  console.log(`  ${chalk.bold("sana_card_transactions")} Card spending history`);
  console.log(`  ${chalk.bold("sana_portfolio")}         Sana wallet net worth & holdings`);
  console.log(`  ${chalk.bold("sana_price")}             Live token prices`);
  console.log(`  ${chalk.bold("sana_swap")}              Swap tokens in Sana wallet`);
  console.log(`  ${chalk.bold("sana_notifications")}     Recent wallet activity`);
  console.log("");
}

export function runSanaUnlink(opts: { profile?: string }): void {
  const name = opts.profile ?? getActiveProfile();
  clearSanaApiKey(name);
  console.log(chalk.yellow(`⚠ Sana key removed from profile "${name}".`));
  console.log(chalk.dim("  Restart your MCP client — sana_* tools will disappear."));
}

export function runSanaStatus(opts: { profile?: string }): void {
  const name = opts.profile ?? getActiveProfile();
  const config = readProfileConfig(name);

  console.log("");
  console.log(chalk.bold(`Sana integration for "${name}"`));
  console.log("");

  if (config.sana?.apiKey) {
    const key = config.sana.apiKey;
    const masked = key.slice(0, 12) + "••••" + key.slice(-4);
    console.log(`  ${chalk.green("●")} Active   ${chalk.dim(masked)}`);
    console.log(chalk.dim("  sana_* tools are registered in the MCP server."));
  } else if (process.env.SANABOT_API_KEY) {
    console.log(`  ${chalk.yellow("●")} Via env  ${chalk.dim("SANABOT_API_KEY is set")}`);
    console.log(chalk.dim("  sana_* tools are registered via the env var (not stored in profile)."));
  } else {
    console.log(`  ${chalk.dim("○")} Not linked`);
    console.log(chalk.dim("  Link with: xpay sana link sana_live_..."));
    console.log(chalk.dim("  Get a key at: https://sana.bot/gateway/app/api-keys"));
  }
  console.log("");
}
