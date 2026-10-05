/**
 * `xpay trust <wallet>` - ERC-8004 and SAID identity + reputation of a Solana wallet.
 *
 * Read-only - does not load a profile or touch keys.
 */

import chalk from "chalk";
import { lookupMerchantTrust } from "../trust/index.js";
import { shortAddress } from "./common.js";
import type { MerchantTrust, SaidTrust, TrustAgent } from "../types.js";

export interface TrustCmdOptions {
  json?: boolean;
}

export async function runTrust(wallet: string, opts: TrustCmdOptions): Promise<void> {
  let trust: MerchantTrust;
  try {
    trust = await lookupMerchantTrust(wallet.trim());
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(trust, null, 2) + "\n");
    return;
  }

  console.log("");
  console.log(`  ${chalk.bold("Wallet")}    ${trust.wallet}`);
  if (trust.agent) {
    printAgent(trust.agent);
    if (trust.agentCount > 1) {
      console.log(chalk.dim(`  (${trust.agentCount} identities linked to this wallet - showing the strongest)`));
    }
  } else {
    console.log(`  ${chalk.bold("Identity")}  ${chalk.yellow("no ERC-8004 identity on Solana")}`);
  }

  console.log("");
  if (trust.said) {
    printSaid(trust.said);
  } else {
    console.log(
      `  ${chalk.bold("SAID")}      ` +
        (trust.said === null ? chalk.yellow("no SAID identity") : chalk.dim("lookup failed - try again")),
    );
  }
  if (!trust.agent && !trust.said) {
    console.log("");
    console.log(chalk.dim("  Most merchants are not registered yet - this is not a red flag on its own."));
  }
  console.log("");
}

function printSaid(s: SaidTrust): void {
  console.log(
    `  ${chalk.bold("SAID")}      ${chalk.green(s.name ?? "identity")}` +
      (s.verified ? chalk.green(" ✓ verified") : chalk.dim(" unverified")),
  );
  console.log(
    `  ${chalk.bold("Score")}     ` +
      (s.score !== null ? scoreColor(s.score)(`${s.score}/100`) : chalk.dim("unscored")) +
      (s.tier ? ` · ${s.tier}` : "") +
      chalk.dim(` (composite, ${s.feedbackCount} review${s.feedbackCount === 1 ? "" : "s"})`),
  );
  if (s.badges.length) console.log(`  ${chalk.bold("Badges")}    ${s.badges.join(", ")}`);
  console.log(`  ${chalk.bold("Profile")}   ${chalk.dim(s.url)}`);
}

function printAgent(a: TrustAgent): void {
  console.log(`  ${chalk.bold("Identity")}  ${chalk.green(a.name ?? `agent #${a.agentId}`)} ${chalk.dim(`#${a.agentId}`)}`);
  console.log(`  ${chalk.bold("Asset")}     ${chalk.dim(a.asset)}`);
  console.log(
    `  ${chalk.bold("Match")}     ${a.matchedBy === "agent_wallet" ? "agent wallet" : "owner"}` +
      chalk.dim(` (owner ${shortAddress(a.owner, 4, 4)})`),
  );
  console.log(
    `  ${chalk.bold("Feedback")}  ` +
      (a.avgScore !== null
        ? `${scoreColor(a.avgScore)(`${a.avgScore}/100`)} from ${a.feedbackCount} review${a.feedbackCount === 1 ? "" : "s"}`
        : chalk.dim("no reviews yet")),
  );
  if (a.atom) {
    console.log(
      `  ${chalk.bold("ATOM")}      ${a.atom.tier} · quality ${a.atom.quality}% · confidence ${a.atom.confidence}% · risk ${a.atom.risk}%`,
    );
  }
  if (a.uri) console.log(`  ${chalk.bold("Card")}      ${chalk.dim(a.uri)}`);
}

export function scoreColor(score: number): (s: string) => string {
  if (score >= 75) return chalk.green;
  if (score >= 50) return chalk.yellow;
  return chalk.red;
}
