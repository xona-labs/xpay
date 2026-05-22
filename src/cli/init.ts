/**
 * `xpay init` — create a new profile (or import one).
 *
 * Flow:
 *   1. Confirm profile name (default: "default") + workspace flag.
 *   2. Either generate a fresh 24-word mnemonic or accept --import.
 *   3. Prompt for passphrase (twice, with confirmation) unless --no-encrypt.
 *   4. Write wallet.json + config.json under ~/.xpay/<name>/ (mode 0700).
 *   5. Print addresses + force user to acknowledge the seed phrase.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { initProfile, profileExists } from "../profile/index.js";
import { assertValidMnemonic } from "../profile/derive.js";

export interface InitCmdOptions {
  name?: string;
  import?: boolean;
  noEncrypt?: boolean;
  workspace?: boolean;
  overwrite?: boolean;
  /** Non-interactive passphrase (for scripts/tests). */
  passphrase?: string;
  /** Non-interactive mnemonic (for scripts/tests). */
  mnemonic?: string;
}

export async function runInit(opts: InitCmdOptions): Promise<void> {
  const name = opts.name ?? "default";

  if (profileExists(name, { workspace: opts.workspace }) && !opts.overwrite) {
    console.error(
      chalk.red(`✗ Profile "${name}" already exists.`) +
        ` Pass --overwrite to replace it (you will lose access to the old wallet).`,
    );
    process.exit(1);
  }

  // --- Mnemonic ---
  let mnemonic: string | undefined = opts.mnemonic;
  if (opts.import && !mnemonic) {
    const answer = await inquirer.prompt<{ mnemonic: string }>([
      {
        type: "input",
        name: "mnemonic",
        message: "Paste your 12- or 24-word recovery phrase:",
        filter: (v: string) => v.trim().toLowerCase().replace(/\s+/g, " "),
      },
    ]);
    mnemonic = answer.mnemonic;
  }
  if (mnemonic) {
    try {
      assertValidMnemonic(mnemonic);
    } catch (err) {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
      process.exit(1);
    }
  }

  // --- Passphrase ---
  let passphrase: string | undefined = opts.passphrase;
  if (!opts.noEncrypt && passphrase === undefined) {
    const { p1, p2 } = await inquirer.prompt<{ p1: string; p2: string }>([
      {
        type: "password",
        name: "p1",
        message: "Encryption passphrase (used to unlock this wallet):",
        mask: "*",
        validate: (v: string) =>
          v.length >= 8 || "Use at least 8 characters (or pass --no-encrypt for dev wallets)",
      },
      { type: "password", name: "p2", message: "Confirm passphrase:", mask: "*" },
    ]);
    if (p1 !== p2) {
      console.error(chalk.red("✗ Passphrases do not match."));
      process.exit(1);
    }
    passphrase = p1;
  }

  // --- Create ---
  const result = await initProfile({
    name,
    mnemonic,
    passphrase,
    workspace: opts.workspace,
    overwrite: opts.overwrite,
  });

  // --- Output ---
  console.log("");
  console.log(chalk.green(`✔ Profile "${result.name}" created at ${result.path}`));
  console.log("");
  console.log(chalk.bold("Addresses:"));
  console.log(`  Solana  ${chalk.cyan(result.addresses.solana)}`);
  console.log(`  EVM     ${chalk.cyan(result.addresses.evm)}`);
  console.log("");

  if (!opts.import) {
    console.log(chalk.yellow.bold("⚠  RECOVERY PHRASE — write this down NOW. We cannot recover it for you."));
    console.log("");
    printMnemonicGrid(result.mnemonic);
    console.log("");

    if (process.stdin.isTTY && !opts.passphrase) {
      const { ack } = await inquirer.prompt<{ ack: boolean }>([
        {
          type: "confirm",
          name: "ack",
          message: "I have written down the recovery phrase in a safe place.",
          default: false,
        },
      ]);
      if (!ack) {
        console.log(chalk.yellow("Take your time. The phrase is also visible above."));
      }
    }
  }

  console.log(chalk.dim("Next steps:"));
  console.log(chalk.dim("  xpay balance        # check funded balance"));
  console.log(chalk.dim("  xpay discover foo   # search the catalog"));
  console.log(chalk.dim("  xpay pay <url>      # pay an x402 endpoint"));
}

function printMnemonicGrid(mnemonic: string): void {
  const words = mnemonic.split(" ");
  const cols = 4;
  for (let i = 0; i < words.length; i += cols) {
    const row = words
      .slice(i, i + cols)
      .map((w, j) => chalk.dim(`${String(i + j + 1).padStart(2)}.`) + ` ${chalk.bold(w.padEnd(12))}`)
      .join("  ");
    console.log("  " + row);
  }
}
