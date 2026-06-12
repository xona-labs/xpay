/**
 * `xpay biometric enable|disable|status` — Touch ID unlock for a profile
 * (macOS only). `enable` verifies the passphrase against the wallet, runs a
 * Touch ID check, then stores the passphrase in the login keychain; from
 * then on `unlockActive` offers Touch ID before falling back to typing.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import {
  BiometricUnavailableError,
  biometricCheck,
  biometricPlatformSupported,
  biometricPrompt,
  deleteBiometricPassphrase,
  storeBiometricPassphrase,
} from "../biometric/index.js";
import { setProfileBiometric, readProfileConfig } from "../profile/index.js";
import { profileExists, profilePath, readWalletFile, unlockWalletFile } from "../profile/storage.js";
import { getActiveProfile } from "./accounts.js";

export interface BiometricCmdOptions {
  profile?: string;
  passphrase?: string;
}

function resolveProfileOrExit(profileName?: string): string {
  const name = profileName ?? getActiveProfile();
  if (!profileExists(name)) {
    console.error(chalk.red(`✗ Profile "${name}" not found. Run \`xpay init\` first.`));
    process.exit(1);
  }
  return name;
}

export async function runBiometricEnable(opts: BiometricCmdOptions): Promise<void> {
  const name = resolveProfileOrExit(opts.profile);

  if (!biometricPlatformSupported()) {
    console.error(chalk.red("✗ Biometric unlock is only supported on macOS (Touch ID)."));
    process.exit(1);
  }

  const wallet = readWalletFile(profilePath(name));
  if (!wallet.encrypted) {
    console.error(
      chalk.red(`✗ Profile "${name}" is unencrypted (dev wallet) — there is no passphrase to protect.`),
    );
    process.exit(1);
  }

  let biometry;
  try {
    biometry = await biometricCheck();
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
  if (!biometry) {
    console.error(chalk.red("✗ No usable biometry — enroll Touch ID in System Settings first."));
    process.exit(1);
  }

  // Verify the passphrase actually unlocks this wallet before storing it.
  let passphrase = opts.passphrase ?? process.env.XPAY_PASSPHRASE;
  if (!passphrase) {
    const a = await inquirer.prompt<{ p: string }>([
      { type: "password", name: "p", message: `Passphrase for "${name}":`, mask: "*" },
    ]);
    passphrase = a.p;
  }
  try {
    unlockWalletFile(wallet, passphrase);
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  try {
    const ok = await biometricPrompt(`enable Touch ID unlock for the xPay profile "${name}"`);
    if (!ok) {
      console.log(chalk.yellow("Cancelled — biometric unlock not enabled."));
      return;
    }
    await storeBiometricPassphrase(name, passphrase);
  } catch (err) {
    const msg =
      err instanceof BiometricUnavailableError
        ? `${err.message} — biometric unlock not enabled.`
        : (err as Error).message;
    console.error(chalk.red(`✗ ${msg}`));
    process.exit(1);
  }

  setProfileBiometric(name, true);
  console.log("");
  console.log(chalk.green(`✔ Touch ID unlock enabled for "${name}".`));
  console.log(chalk.dim("  The passphrase now lives in your login keychain, gated by Touch ID."));
  console.log(chalk.dim("  macOS may ask once to allow keychain access — choose \"Always Allow\"."));
  console.log(chalk.dim("  Your passphrase still works everywhere and remains the recovery path."));
}

export async function runBiometricDisable(opts: BiometricCmdOptions): Promise<void> {
  const name = resolveProfileOrExit(opts.profile);
  try {
    await deleteBiometricPassphrase(name);
  } catch (err) {
    if (!(err instanceof BiometricUnavailableError)) {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
      process.exit(1);
    }
    // Helper unbuildable (e.g. CLT removed) — still clear the config flag.
  }
  setProfileBiometric(name, false);
  console.log(chalk.green(`✔ Touch ID unlock disabled for "${name}" — keychain entry removed.`));
}

export async function runBiometricStatus(profileName?: string): Promise<void> {
  const name = resolveProfileOrExit(profileName);
  const config = readProfileConfig(name);

  console.log(chalk.bold(`Biometric unlock for "${name}"`));
  if (!biometricPlatformSupported()) {
    console.log(chalk.yellow("  unsupported platform (macOS only)"));
    return;
  }

  let biometry: string | null = null;
  let unavailableReason: string | undefined;
  try {
    biometry = await biometricCheck();
  } catch (err) {
    unavailableReason = (err as Error).message;
  }

  const hardware = biometry
    ? chalk.green(biometry === "faceid" ? "Face ID" : "Touch ID")
    : chalk.yellow(unavailableReason ?? "not available (no enrolled biometry?)");
  console.log(`  biometry   ${hardware}`);
  console.log(
    `  enabled    ${config.biometric?.enabled ? chalk.green("yes") : chalk.dim("no")}`,
  );
  if (!config.biometric?.enabled && biometry) {
    console.log(chalk.dim("  Enable with: xpay biometric enable"));
  }
}
