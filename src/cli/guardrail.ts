/**
 * `xpay guardrail show|set|clear` — view and edit the active profile's
 * spending guardrail. Persisted to config.json; loaded by every command that
 * builds a runtime client.
 */

import chalk from "chalk";
import {
  clearProfileGuardrail,
  readProfileConfig,
  setProfileGuardrail,
} from "../profile/index.js";
import { getActiveProfile } from "./accounts.js";

export interface GuardrailSetOptions {
  profile?: string;
  maxPerTx?: string;
  maxPerDay?: string;
  allowedHosts?: string; // comma-separated
  requireApprovalAbove?: string;
}

export function runGuardrailShow(profileName?: string): void {
  const name = profileName ?? getActiveProfile();
  const config = readProfileConfig(name);
  const g = config.guardrail;

  console.log("");
  console.log(chalk.bold(`Guardrail for "${name}"`));
  if (!g || Object.keys(g).length === 0) {
    console.log(chalk.yellow("  (no guardrail configured — calls are uncapped)"));
    console.log(chalk.dim("  Set one with: xpay guardrail set --max-per-tx 1 --max-per-day 10"));
    return;
  }
  console.log("");
  if (g.maxPerTx !== undefined) console.log(`  max per tx          $${g.maxPerTx.toFixed(4)}`);
  if (g.maxPerDay !== undefined) console.log(`  max per 24h         $${g.maxPerDay.toFixed(4)}`);
  if (g.requireApprovalAbove !== undefined)
    console.log(`  approval above      $${g.requireApprovalAbove.toFixed(4)}`);
  if (g.allowedHosts?.length) {
    console.log(`  allowed hosts       ${g.allowedHosts.join(", ")}`);
  } else {
    console.log(`  allowed hosts       ${chalk.dim("(any)")}`);
  }
  console.log("");
}

export function runGuardrailSet(opts: GuardrailSetOptions): void {
  const name = opts.profile ?? getActiveProfile();
  const patch: NonNullable<ReturnType<typeof readProfileConfig>["guardrail"]> = {};

  if (opts.maxPerTx !== undefined) patch.maxPerTx = parseDollarsOrExit(opts.maxPerTx, "--max-per-tx");
  if (opts.maxPerDay !== undefined) patch.maxPerDay = parseDollarsOrExit(opts.maxPerDay, "--max-per-day");
  if (opts.requireApprovalAbove !== undefined)
    patch.requireApprovalAbove = parseDollarsOrExit(opts.requireApprovalAbove, "--require-approval-above");
  if (opts.allowedHosts !== undefined) {
    patch.allowedHosts = opts.allowedHosts
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (Object.keys(patch).length === 0) {
    console.error(chalk.red("✗ no fields provided. See `xpay guardrail set --help`."));
    process.exit(1);
  }

  setProfileGuardrail(name, patch);
  console.log(chalk.green(`✔ Guardrail updated for "${name}"`));
  runGuardrailShow(name);
}

export function runGuardrailClear(profileName?: string): void {
  const name = profileName ?? getActiveProfile();
  clearProfileGuardrail(name);
  console.log(chalk.yellow(`⚠ Guardrail cleared for "${name}" — calls are now uncapped.`));
}

function parseDollarsOrExit(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(chalk.red(`✗ ${flag} must be a non-negative number (got "${raw}")`));
    process.exit(1);
  }
  return n;
}
