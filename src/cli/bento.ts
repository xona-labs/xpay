/**
 * `xpay bento enable|disable|status` — toggle the Bento Guard intent firewall
 * for the active profile.
 *
 * Unlike Sana, Bento has no API key: it authenticates with the wallet's own
 * key (createXPay exposes it via AGENT_WALLET_PRIVATE_KEY at runtime). The one
 * manual step is registering the wallet address once at app.bentoguard.xyz —
 * `enable` prints that address and walks you through it.
 *
 * When enabled, every pay / transfer is screened by Bento's protect() for
 * malicious intent (prompt-injection, wallet-drain) before signing — a second
 * gate on top of the local guardrail caps.
 */

import chalk from "chalk";
import { setProfileBento, readProfileConfig } from "../profile/index.js";
import { profileExists, profilePath, readWalletFile } from "../profile/storage.js";
import { getActiveProfile } from "./accounts.js";

const DASHBOARD = "https://app.bentoguard.xyz/";

function resolveProfileOrExit(profileName?: string): string {
  const name = profileName ?? getActiveProfile();
  if (!profileExists(name)) {
    console.error(chalk.red(`✗ Profile "${name}" not found. Run \`xpay init\` first.`));
    process.exit(1);
  }
  return name;
}

export function runBentoEnable(opts: { profile?: string }): void {
  const name = resolveProfileOrExit(opts.profile);
  const { addresses } = readWalletFile(profilePath(name));

  setProfileBento(name, true);

  console.log("");
  console.log(chalk.green(`✔ Bento intent firewall enabled for "${name}".`));
  console.log("");
  console.log(chalk.bold("  One-time setup — register this wallet:"));
  console.log(`    1. Open  ${chalk.cyan(DASHBOARD)}`);
  console.log(`    2. Register your agent wallet address:`);
  console.log(`       ${chalk.yellow(addresses.solana)}`);
  console.log(
    `    3. Leave spend limits unset — xPay's own guardrail handles caps; Bento adds intent screening.`,
  );
  console.log("");
  console.log(chalk.dim("  From now on every pay / transfer is screened by Bento's intent"));
  console.log(chalk.dim("  analysis (prompt-injection / wallet-drain) before signing."));
  console.log(chalk.dim("  Until the address is registered, paid calls fail with a"));
  console.log(chalk.dim('  "not registered" error — that is expected.'));
  console.log("");
}

export function runBentoDisable(opts: { profile?: string }): void {
  const name = resolveProfileOrExit(opts.profile);
  setProfileBento(name, false);
  console.log(chalk.yellow(`⚠ Bento intent firewall disabled for "${name}".`));
  console.log(chalk.dim("  Payments now rely on the local guardrail caps only."));
}

export function runBentoStatus(opts: { profile?: string }): void {
  const name = resolveProfileOrExit(opts.profile);
  const config = readProfileConfig(name);
  const { addresses } = readWalletFile(profilePath(name));

  console.log("");
  console.log(chalk.bold(`Bento intent firewall for "${name}"`));
  console.log("");
  if (config.bento?.enabled) {
    console.log(`  ${chalk.green("●")} Enabled`);
    console.log(chalk.dim("  Screening pay / transfer via protect() before signing."));
    console.log(chalk.dim(`  Registered wallet should be: ${addresses.solana}`));
    console.log(chalk.dim(`  Dashboard: ${DASHBOARD}`));
  } else {
    console.log(`  ${chalk.dim("○")} Disabled`);
    console.log(chalk.dim("  Enable with: xpay bento enable"));
  }
  console.log("");
}
