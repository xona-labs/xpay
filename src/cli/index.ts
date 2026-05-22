#!/usr/bin/env node
/**
 * xpay CLI — agentic-commerce wallet.
 *
 * Top-level commands:
 *   xpay init [--import] [--no-encrypt] [--workspace]
 *   xpay accounts list|show|use
 *   xpay balance [--network solana|base|...]
 *   xpay mcp                                 (default: start MCP server on stdio)
 *
 * More to come: discover, pay, transfer, history, bridge, guardrail, link.
 *
 * Designed to also run as the MCP server entry point (the `bin` field points
 * here) — invoking `xpay-mcp` directly defaults to the `mcp` subcommand.
 */

import "dotenv/config";
import { basename } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { runInit } from "./init.js";
import { runAccountsList, runAccountsShow, runAccountsUse } from "./accounts.js";
import { runBalance } from "./balance.js";
import { runDiscover } from "./discover.js";
import { runPay } from "./pay.js";
import { runHistory } from "./history.js";
import { runTransfer } from "./transfer.js";
import { runGuardrailShow, runGuardrailSet, runGuardrailClear } from "./guardrail.js";
import { startMcpServer } from "./mcp-server.js";

const program = new Command();

program
  .name("xpay")
  .description("xPay — discovery, payments, and wallet for agentic commerce.")
  .version("0.1.0");

// ---------------------------------------------------------------- init
program
  .command("init [name]")
  .description("Create a new profile (Solana + EVM keys).")
  .option("--import", "Import an existing recovery phrase instead of generating one")
  .option("--no-encrypt", "Skip passphrase encryption (dev wallets only)")
  .option("--workspace", "Store under <cwd>/.xpay/ instead of ~/.xpay/")
  .option("--overwrite", "Replace an existing profile with the same name")
  .option("--passphrase <value>", "Non-interactive passphrase (scripts/tests)")
  .option("--mnemonic <phrase>", "Non-interactive mnemonic (scripts/tests)")
  .action(async (name: string | undefined, opts) => {
    await runInit({ name, ...opts });
  });

// ---------------------------------------------------------------- accounts
const accounts = program
  .command("accounts")
  .description("Manage local profiles.");

accounts
  .command("list", { isDefault: true })
  .description("List all profiles in ~/.xpay/.")
  .action(() => runAccountsList());

accounts
  .command("show [name]")
  .description("Show addresses + metadata for a profile.")
  .action((name?: string) => runAccountsShow(name));

accounts
  .command("use <name>")
  .description("Set the active profile.")
  .action((name: string) => runAccountsUse(name));

// ---------------------------------------------------------------- discover
program
  .command("discover [query]")
  .description("Search the agentic-commerce catalog (PayAI + sources).")
  .option("--limit <n>", "Max results (default 10)")
  .option("--network <net>", "Filter by network (solana, base, ...)")
  .option("--json", "Emit raw JSON instead of the table view")
  .action(async (query: string | undefined, opts) => {
    await runDiscover(query, opts);
  });

// ---------------------------------------------------------------- pay
program
  .command("pay <url>")
  .description("Pay an x402 endpoint (catalog URL or any URL that returns 402).")
  .option("--profile <name>", "Profile to pay from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--max-usd <n>", "Override per-tx guardrail cap for this call")
  .option("--body <json>", "Request body for POST endpoints (JSON)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (url: string, opts) => {
    await runPay(url, opts);
  });

// ---------------------------------------------------------------- history
program
  .command("history")
  .description("Recent USDC activity across all configured networks.")
  .option("--profile <name>", "Profile to query (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--network <net>", "Restrict to one network")
  .option("--limit <n>", "Max entries (default 25)")
  .option("--evm-window <blocks>", "Block window for EVM scans (default 100000)")
  .option("--json", "Emit raw JSON")
  .action(async (opts) => {
    await runHistory(opts);
  });

// ---------------------------------------------------------------- transfer
program
  .command("transfer <amount> <token> <to>")
  .description("Send USDC to an address (no x402). Subject to the active guardrail.")
  .option("--profile <name>", "Profile to send from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--network <net>", "Force network (solana, base, ethereum, ...)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (amount: string, token: string, to: string, opts) => {
    await runTransfer(amount, token, to, opts);
  });

// ---------------------------------------------------------------- guardrail
const guardrail = program
  .command("guardrail")
  .description("Inspect or edit spending caps for the active profile.");

guardrail
  .command("show [profile]", { isDefault: true })
  .description("Print the current guardrail config.")
  .action((profile?: string) => runGuardrailShow(profile));

guardrail
  .command("set")
  .description("Update guardrail fields. Unspecified fields are left alone.")
  .option("--profile <name>", "Profile to edit (defaults to active)")
  .option("--max-per-tx <usd>", "Hard cap per single call (USD)")
  .option("--max-per-day <usd>", "Hard cap per rolling 24h (USD)")
  .option("--require-approval-above <usd>", "Calls ≥ USD require an approval hook (set in SDK)")
  .option("--allowed-hosts <list>", "Comma-separated host globs (use '*' to allow any)")
  .action((opts) => runGuardrailSet(opts));

guardrail
  .command("clear [profile]")
  .description("Remove the guardrail entirely.")
  .action((profile?: string) => runGuardrailClear(profile));

// ---------------------------------------------------------------- balance
program
  .command("balance")
  .description("Show USDC balance per network for the active profile.")
  .option("--profile <name>", "Profile to query (defaults to active)")
  .option("--network <net>", "Restrict to one network (solana, base, ...)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .action(async (opts) => {
    await runBalance(opts);
  });

// ---------------------------------------------------------------- mcp
program
  .command("mcp")
  .description("Start the MCP server on stdio (for Claude Desktop / Cursor / Codex).")
  .action(async () => {
    process.stderr.write(chalk.cyan("[xpay-mcp] starting...\n"));
    try {
      await startMcpServer();
    } catch (err) {
      process.stderr.write(chalk.red(`[xpay-mcp] fatal: ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------- run
// When invoked as `xpay-mcp` (or any binary name containing "mcp"), default to
// the MCP server so MCP hosts don't need a subcommand in their config.
const invokedAs = basename(process.argv[1] ?? "");
if (invokedAs.includes("mcp") && process.argv.length <= 2) {
  process.argv.push("mcp");
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(chalk.red(`xpay: ${err}\n`));
  process.exit(1);
});
