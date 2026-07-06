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
import { createRequire } from "node:module";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require("../../package.json") as { version: string };
import chalk from "chalk";
import { runInit } from "./init.js";
import { runAccountsList, runAccountsShow, runAccountsUse } from "./accounts.js";
import { runBalance } from "./balance.js";
import { runDiscover } from "./discover.js";
import { runPay } from "./pay.js";
import { runReport } from "./report.js";
import { runTransfer } from "./transfer.js";
import { runGuardrailShow, runGuardrailSet, runGuardrailClear } from "./guardrail.js";
import { runBiometricEnable, runBiometricDisable, runBiometricStatus } from "./biometric.js";
import {
  runSanaLink, runSanaUnlink, runSanaStatus,
  runSanaCard, runSanaCardBalance, runSanaCardDeposit, runSanaCardTransactions,
  runSanaPortfolio, runSanaPrice, runSanaSwap, runSanaNotifications,
} from "./sana.js";
import {
  runMagicBlockStatus,
  runMagicBlockInitMint,
  runMagicBlockConfigure,
} from "./magicblock.js";
import { runBentoEnable, runBentoDisable, runBentoStatus } from "./bento.js";
import { runAgencHire, runAgencStatus } from "./agenc.js";
import { runTokenFind } from "./token.js";
import { runSwap } from "./swap.js";
import { runXUser, runXPosts } from "./x.js";
import { runZauthScan, runZauthStatus } from "./zauth.js";
import { startMcpServer } from "./mcp-server.js";

const program = new Command();

program
  .name("xpay")
  .description("xPay — discovery, payments, and wallet for agentic commerce.")
  .version(pkgVersion);

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
  .description("Search the agentic-commerce catalog (PayAI + OrbitX402 + AgenC hireable agents).")
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
  .option("--method <m>", "HTTP method (default GET — use POST for most x402 services)")
  .option("--max-usd <n>", "Override per-tx guardrail cap for this call")
  .option("--body <json>", "Request body for POST endpoints (JSON)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (url: string, opts) => {
    await runPay(url, opts);
  });

// ---------------------------------------------------------------- report
program
  .command("report")
  .description("Comprehensive USDC activity report (daily / weekly / monthly) via OrbitX402.")
  .option("--profile <name>", "Profile to query (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--network <net>", "Network to report on (default: solana)")
  .option("--period <p>", "Report window: daily | weekly | monthly (default: weekly)")
  .option("--json", "Emit raw JSON")
  .action(async (opts) => {
    await runReport(opts);
  });

// ---------------------------------------------------------------- token
const token = program
  .command("token")
  .description("Solana token discovery (Jupiter).");

token
  .command("find <query>", { isDefault: true })
  .description("Find a token by ticker, name, or mint address. Read-only, no wallet.")
  .option("--limit <n>", "Max results (default 10)")
  .option("--json", "Emit raw JSON")
  .action(async (query: string, opts) => {
    await runTokenFind(query, opts);
  });

// ---------------------------------------------------------------- x (Twitter)
const xcmd = program
  .command("x")
  .description("Realtime X (Twitter) account data — paid via x402 at cost (no X account needed).");

xcmd
  .command("user <handle>")
  .description("Profile lookup: followers, bio, verification (~$0.01 USDC).")
  .option("--profile <name>", "Profile to pay from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--json", "Emit raw JSON")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (handle: string, opts) => {
    await runXUser(handle, opts);
  });

xcmd
  .command("posts <handle>")
  .description("Recent original posts with engagement metrics (~$0.06 USDC for 10).")
  .option("--profile <name>", "Profile to pay from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--limit <n>", "Posts to return, 1-10 (default 10)")
  .option("--json", "Emit raw JSON")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (handle: string, opts) => {
    await runXPosts(handle, opts);
  });

// ---------------------------------------------------------------- zauth
const zauth = program
  .command("zauth")
  .description("zauth partner — repository security scans, paid via x402.");

zauth
  .command("reposcan <repoUrl>")
  .description("Scan a repository via zauth (~$0.05 USDC, paid via x402).")
  .option("--profile <name>", "Profile to pay from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--json", "Emit raw JSON")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (repoUrl: string, opts) => {
    await runZauthScan(repoUrl, opts);
  });

zauth
  .command("status <sessionToken>")
  .description("Check a running scan (free, read-only, no wallet needed).")
  .option("--json", "Emit raw JSON")
  .action(async (sessionToken: string, opts) => {
    await runZauthStatus(sessionToken, opts);
  });

// ---------------------------------------------------------------- swap
program
  .command("swap <amount> <fromToken> <toToken>")
  .description("Swap tokens in your wallet via Jupiter (Solana only). Subject to the guardrail.")
  .option("--profile <name>", "Profile to swap from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--slippage-bps <n>", "Max slippage in bps (default: Jupiter dynamic slippage)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (amount: string, fromToken: string, toToken: string, opts) => {
    await runSwap(amount, fromToken, toToken, opts);
  });

// ---------------------------------------------------------------- transfer
program
  .command("transfer <amount> <token> <to>")
  .description("Send USDC to an address (no x402). Subject to the active guardrail.")
  .option("--profile <name>", "Profile to send from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--network <net>", "Force network (solana, base, ethereum, ...)")
  .option("--private", "Route through MagicBlock Private Ephemeral Rollup (Solana only)")
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

// ---------------------------------------------------------------- biometric
const biometric = program
  .command("biometric")
  .description("Touch ID unlock for profile passphrases (macOS only).");

biometric
  .command("status [profile]", { isDefault: true })
  .description("Show biometric availability + whether unlock is enabled.")
  .action(async (profile?: string) => runBiometricStatus(profile));

biometric
  .command("enable")
  .description("Store the wallet passphrase in the keychain, gated by Touch ID.")
  .option("--profile <name>", "Profile to enable (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase (scripts/tests)")
  .action(async (opts) => runBiometricEnable(opts));

biometric
  .command("disable")
  .description("Remove the keychain entry and turn Touch ID unlock off.")
  .option("--profile <name>", "Profile to disable (defaults to active)")
  .action(async (opts) => runBiometricDisable(opts));

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

// ---------------------------------------------------------------- sana
const sana = program
  .command("sana")
  .description("Manage the Sana agent wallet card integration (optional).");

sana
  .command("link <apiKey>")
  .description("Link a Sana API key — enables sana_* tools in the MCP server.")
  .option("--profile <name>", "Profile to link to (defaults to active)")
  .action((apiKey: string, opts) => runSanaLink(apiKey, opts));

sana
  .command("unlink")
  .description("Remove the Sana API key from the active profile.")
  .option("--profile <name>", "Profile to unlink from (defaults to active)")
  .action((opts) => runSanaUnlink(opts));

sana
  .command("status", { isDefault: true })
  .description("Show whether a Sana key is configured for the active profile.")
  .option("--profile <name>", "Profile to check (defaults to active)")
  .action((opts) => runSanaStatus(opts));

sana
  .command("card")
  .description("Card metadata — status, type, last 4, expiry.")
  .option("--profile <name>")
  .action((opts) => runSanaCard(opts));

sana
  .command("card-balance")
  .description("Available spending power on the Sana card.")
  .option("--profile <name>")
  .action((opts) => runSanaCardBalance(opts));

sana
  .command("card-deposit <amount>")
  .description("Top up the card with USDC (e.g. xpay sana card-deposit 10).")
  .option("--profile <name>")
  .action((amount: string, opts) => runSanaCardDeposit(amount, opts));

sana
  .command("card-transactions")
  .description("Card spending history.")
  .option("--profile <name>")
  .option("--limit <n>", "Max entries")
  .action((opts) => runSanaCardTransactions(opts));

sana
  .command("portfolio")
  .description("Sana wallet net worth + token holdings.")
  .option("--profile <name>")
  .action((opts) => runSanaPortfolio(opts));

sana
  .command("price <token>")
  .description("Live price for a token (e.g. xpay sana price SOL).")
  .option("--profile <name>")
  .action((token: string, opts) => runSanaPrice(token, opts));

sana
  .command("swap <fromToken> <toToken> <amount>")
  .description("Swap tokens in Sana wallet (e.g. xpay sana swap SOL USDC 0.5).")
  .option("--profile <name>")
  .action((from: string, to: string, amount: string, opts) => runSanaSwap(from, to, amount, opts));

sana
  .command("notifications")
  .description("Recent Sana wallet activity feed.")
  .option("--profile <name>")
  .action((opts) => runSanaNotifications(opts));

// ---------------------------------------------------------------- bento
const bento = program
  .command("bento")
  .description("Bento Guard intent firewall — screen payments for malicious intent (optional).");

bento
  .command("status", { isDefault: true })
  .description("Show whether the Bento intent firewall is enabled.")
  .option("--profile <name>", "Profile to check (defaults to active)")
  .action((opts) => runBentoStatus(opts));

bento
  .command("enable")
  .description("Enable Bento intent screening for payments (register your wallet first).")
  .option("--profile <name>", "Profile to enable (defaults to active)")
  .action((opts) => runBentoEnable(opts));

bento
  .command("disable")
  .description("Disable Bento intent screening — payments rely on local caps only.")
  .option("--profile <name>", "Profile to disable (defaults to active)")
  .action((opts) => runBentoDisable(opts));

// ---------------------------------------------------------------- magicblock
const magicblock = program
  .command("magicblock")
  .description("MagicBlock Private Ephemeral Rollup — platform-level privacy setup (operator commands).");

magicblock
  .command("status", { isDefault: true })
  .description("Show MagicBlock PER integration status and mint initialization state.")
  .option("--profile <name>", "Profile to check (defaults to active)")
  .action(async (opts) => runMagicBlockStatus(opts));

magicblock
  .command("init-mint")
  .description("Register USDC on MagicBlock's rollup (one-time platform setup, signed by your wallet).")
  .option("--profile <name>", "Profile to use (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--mint <address>", "SPL mint to initialize (defaults to USDC mainnet)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts) => runMagicBlockInitMint(opts));

magicblock
  .command("configure")
  .description("Save custom MagicBlock API endpoints to the profile (for self-hosted or staging instances).")
  .option("--profile <name>", "Profile to configure (defaults to active)")
  .option("--api-url <url>", "MagicBlock Payments API base URL")
  .option("--ephemeral-rpc <url>", "Ephemeral rollup RPC endpoint")
  .option("--clear", "Remove custom config and revert to defaults")
  .action((opts) => runMagicBlockConfigure(opts));

// ---------------------------------------------------------------- agenc
const agenc = program
  .command("agenc")
  .description("AgenC marketplace (agenc.ag) — hire on-chain agent services with SOL escrow.");

agenc
  .command("hire <listingPda>")
  .description("Hire a listing: escrow its SOL price on-chain; the provider works asynchronously.")
  .option("--profile <name>", "Profile to hire from (defaults to active)")
  .option("--passphrase <value>", "Non-interactive passphrase")
  .option("--max-usd <n>", "Override per-tx guardrail cap for this hire")
  .option("--review-window <secs>", "Review window after the provider submits (default 86400)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (listingPda: string, opts) => {
    await runAgencHire(listingPda, opts);
  });

agenc
  .command("status <taskPda>")
  .description("Check the progress of a hire (read-only, no wallet needed).")
  .option("--json", "Emit raw JSON")
  .action(async (taskPda: string, opts) => {
    await runAgencStatus(taskPda, opts);
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
