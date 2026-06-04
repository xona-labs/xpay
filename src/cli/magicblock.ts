/**
 * `xpay magicblock` — platform-level MagicBlock PER integration commands.
 *
 * xpay acts as the privacy platform: end users never need a MagicBlock account.
 * These commands are for the xpay operator (platform team) to run once.
 *
 * Usage:
 *   xpay magicblock status                  Show integration status
 *   xpay magicblock init-mint               Register USDC on MagicBlock (one-time setup)
 *   xpay magicblock configure --api-url ... Save a custom API URL to the profile
 */

import chalk from "chalk";
import {
  setMagicBlockConfig,
  clearMagicBlockConfig,
  readProfileConfig,
} from "../profile/index.js";
import { magicBlockIsMintInitialized, magicBlockInitializeMint } from "../magicblock/client.js";
import { getActiveProfile } from "./accounts.js";
import { unlockActive } from "./common.js";
import { createXPay } from "../index.js";

const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ─── Status ───────────────────────────────────────────────────────────────────

export async function runMagicBlockStatus(opts: { profile?: string }): Promise<void> {
  const name   = opts.profile ?? getActiveProfile();
  const config = readProfileConfig(name);
  const mb     = config.magicblock;

  console.log("");
  console.log(chalk.bold(`MagicBlock PER integration for "${name}"`));
  console.log("");

  const apiUrl = mb?.apiUrl ?? process.env.MAGICBLOCK_API_URL ?? "https://payments.magicblock.app";
  const ephRpc = mb?.ephemeralRpc ?? process.env.MAGICBLOCK_EPHEMERAL_RPC ?? "https://mainnet.magicblock.app/ephemeral";

  const apiSource = mb?.apiUrl ? "profile" : process.env.MAGICBLOCK_API_URL ? "env" : "default";
  const rpcSource = mb?.ephemeralRpc ? "profile" : process.env.MAGICBLOCK_EPHEMERAL_RPC ? "env" : "default";

  console.log(`  ${chalk.dim("API URL        ")} ${apiUrl} ${chalk.dim(`(${apiSource})`)}`);
  console.log(`  ${chalk.dim("Ephemeral RPC  ")} ${ephRpc} ${chalk.dim(`(${rpcSource})`)}`);
  console.log("");

  process.stdout.write(`  Checking USDC mint initialization...`);
  const initialized = await magicBlockIsMintInitialized(USDC_SOLANA, mb).catch(() => false);
  process.stdout.write("\r");
  if (initialized) {
    console.log(`  ${chalk.green("●")} USDC mint is initialized — private transfers are ready.`);
  } else {
    console.log(`  ${chalk.yellow("●")} USDC mint is not yet initialized.`);
    console.log(chalk.dim("    Run: xpay magicblock init-mint"));
  }
  console.log("");
  console.log(chalk.dim("  End users pass private:true to xpay_transfer — no MagicBlock account needed."));
  console.log("");
}

// ─── Init mint (one-time platform setup) ─────────────────────────────────────

export async function runMagicBlockInitMint(opts: {
  profile?: string;
  passphrase?: string;
  mint?: string;
  yes?: boolean;
}): Promise<void> {
  const mint = opts.mint ?? USDC_SOLANA;

  const profile = await unlockActive(opts);
  const xpay    = createXPay({ profile });
  const config  = profile.config.magicblock;

  const alreadyInit = await magicBlockIsMintInitialized(mint, config).catch(() => false);
  if (alreadyInit) {
    console.log(chalk.green("✔ Mint is already initialized on MagicBlock. Nothing to do."));
    return;
  }

  if (!opts.yes) {
    const { default: inquirer } = await import("inquirer");
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Initialize mint ${chalk.cyan(mint.slice(0, 8) + "…")} on MagicBlock? (one-time, platform-level setup)`,
        default: false,
      },
    ]);
    if (!go) { console.log(chalk.yellow("Cancelled.")); return; }
  }

  const signer = xpay.wallet.signer("solana");

  try {
    process.stdout.write("  Initializing mint...\n");
    const sig = await magicBlockInitializeMint({ signer, mint, config });
    console.log(chalk.green(`✔ Mint initialized.`));
    console.log(`  ${chalk.dim("→ tx:")} ${sig}`);
    console.log("");
    console.log(chalk.dim("  Users can now call xpay_transfer with private:true on Solana."));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}

// ─── Configure platform endpoints ────────────────────────────────────────────

export function runMagicBlockConfigure(opts: {
  profile?: string;
  apiUrl?: string;
  ephemeralRpc?: string;
  clear?: boolean;
}): void {
  const name = opts.profile ?? getActiveProfile();

  if (opts.clear) {
    clearMagicBlockConfig(name);
    console.log(chalk.yellow(`⚠ MagicBlock config cleared from profile "${name}" — using defaults.`));
    return;
  }

  if (!opts.apiUrl && !opts.ephemeralRpc) {
    console.error(chalk.red("✗ Pass at least one of --api-url or --ephemeral-rpc."));
    process.exit(1);
  }

  setMagicBlockConfig(name, {
    ...(opts.apiUrl       ? { apiUrl: opts.apiUrl }             : {}),
    ...(opts.ephemeralRpc ? { ephemeralRpc: opts.ephemeralRpc } : {}),
  });

  console.log(chalk.green(`✔ MagicBlock config saved to profile "${name}".`));
  if (opts.apiUrl)       console.log(`  ${chalk.dim("API URL:      ")} ${opts.apiUrl}`);
  if (opts.ephemeralRpc) console.log(`  ${chalk.dim("Ephemeral RPC:")} ${opts.ephemeralRpc}`);
}
