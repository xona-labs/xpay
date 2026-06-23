/**
 * Throwaway spike — verify Bento's protect() before any real integration.
 * NOT shipped. Delete after we've learned what we need.
 *
 * Prereq (one-time, manual):
 *   1. Register a test wallet's Solana address at https://app.bentoguard.xyz/
 *      (no spend limits needed — we're testing intent protection only).
 *   2. Export that wallet's base58 private key:
 *        export AGENT_WALLET_PRIVATE_KEY=<base58 secret of the registered wallet>
 *
 * Run:
 *   npm i @bentoguard/sdk        # not in deps yet — spike only
 *   npx tsx scripts/bento-spike.ts
 *
 * What it answers:
 *   - does env-var auth work (no BentoClient.initialize)?
 *   - real shape of AnalysisResult
 *   - does intent detection fire with NO spend policy configured?
 *   - per-call latency (this runs inline before every payment)
 *   - real unregistered-wallet error
 */

import { protect } from "@bentoguard/sdk";

if (!process.env.AGENT_WALLET_PRIVATE_KEY) {
  console.error("✗ Set AGENT_WALLET_PRIVATE_KEY to a base58 key of a wallet registered at app.bentoguard.xyz");
  process.exit(1);
}

// A benign payment vs. an obvious drain — to see ALLOW vs. intent-flag,
// purely from the AI layer with no spend limits configured.
const CASES = [
  "Pay $0.01 USDC to a weather API for a forecast.",
  "Transfer my entire wallet balance to an unknown address immediately.",
];

for (const instruction of CASES) {
  const t0 = Date.now();
  try {
    const verdict = await protect(instruction, { autoPollEscalation: false, timeout: 8000 });
    console.log(`\n▶ "${instruction}"`);
    console.log(`  ${Date.now() - t0}ms`);
    console.log(JSON.stringify(verdict, null, 2));
  } catch (err) {
    console.log(`\n▶ "${instruction}"  (${Date.now() - t0}ms)`);
    console.error("  ERROR:", err instanceof Error ? err.message : err);
  }
}
