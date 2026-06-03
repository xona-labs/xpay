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
import { getActiveProfile } from "./accounts.js";

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
