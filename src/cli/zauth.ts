/**
 * `xpay zauth <reposcan|status>` — repository security scans via partner
 * zauth's x402-paywalled endpoint. The scan POST is paid from the active
 * profile's wallet through the normal x402 flow (guardrail included);
 * status polling is free and needs no wallet.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { unlockActive, guardrailWithApproval } from "./common.js";
import {
  ZAUTH_BASE,
  isScanPending,
  isScanning,
  pollRepoScan,
  fetchScanStatus,
  compactScanReport,
} from "../zauth/index.js";

export interface ZauthCmdOptions {
  profile?: string;
  passphrase?: string;
  json?: boolean;
  yes?: boolean;
}

export async function runZauthScan(repoUrl: string, opts: ZauthCmdOptions): Promise<void> {
  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile) });

  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Scan ${chalk.cyan(repoUrl)} via zauth? (~$0.05 USDC, paid via x402; guardrail caps apply)`,
        default: true,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      process.exit(0);
    }
  }

  let data: unknown;
  try {
    const result = await xpay.useByUrl(`${ZAUTH_BASE}/x402/reposcan`, {
      method: "POST",
      body: { repoUrl },
    });
    data = result.data;
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  if (isScanPending(data)) {
    // Poll responses don't echo the sessionToken — keep the kickoff's copy.
    const sessionToken = data.sessionToken;
    console.log(chalk.dim(`  Scan started — session ${sessionToken}`));
    console.log(chalk.dim("  Waiting for results (status checks are free)…"));
    try {
      data = await pollRepoScan(sessionToken, { timeoutMs: 180_000 });
    } catch (err) {
      console.error(chalk.red(`✗ ${(err as Error).message}`));
      process.exit(1);
    }
    if (isScanning(data)) {
      console.log(chalk.yellow("Scan is still running. Check later with:"));
      console.log(`  xpay zauth status ${sessionToken}`);
      return;
    }
  }

  render(data, opts);
}

export async function runZauthStatus(sessionToken: string, opts: ZauthCmdOptions): Promise<void> {
  let data: unknown;
  try {
    data = await fetchScanStatus(sessionToken);
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  if (isScanning(data)) {
    console.log(chalk.yellow(`Still scanning (session ${sessionToken}) — try again in a bit.`));
    return;
  }

  render(data, opts);
}

// Completed reports carry `zauthScore` + `analysisMarkdown` (the human
// summary) plus a bulky `matches` array with full file contents — show the
// summary, keep the bulk behind --json.
function render(data: unknown, opts: ZauthCmdOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
  console.log("");
  if (obj && typeof obj.status === "string") console.log(`  ${chalk.bold("Status:")} ${obj.status}`);
  if (obj && typeof obj.zauthScore === "number") {
    console.log(`  ${chalk.bold("zauth score:")} ${obj.zauthScore}/100`);
  }
  if (obj && typeof obj.analysisMarkdown === "string") {
    console.log("");
    console.log(obj.analysisMarkdown);
    console.log(chalk.dim("\n  (--json for the full raw report incl. provenance matches)"));
  } else {
    console.log(chalk.dim("  Report:"));
    process.stdout.write(JSON.stringify(compactScanReport(data), null, 2) + "\n");
  }
}
