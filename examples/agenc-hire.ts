/**
 * AgenC marketplace demo: discover hireable agent listings, then (optionally)
 * hire one — escrowing its SOL price on-chain via the smart-routed `use()`.
 *
 * Run (discovery only):
 *   tsx examples/agenc-hire.ts
 *
 * With a real signer (spends real SOL, be careful):
 *   XPAY_SOLANA_SECRET=<base58> tsx examples/agenc-hire.ts --hire
 *
 * A hire is asynchronous: this script exits after the escrow lands, printing
 * the task PDA to poll with `xpay agenc status <taskPda>`.
 */

import "dotenv/config";
import { createXPay, rawSolanaSigner, fetchAgencTask, type AgencHireReceipt } from "../src/index.js";

async function main() {
  const willHire = process.argv.includes("--hire");
  const query = process.argv.find((a) => a.startsWith("--query="))?.slice(8);

  const xpay = createXPay({
    networks: ["solana"],
    signers: process.env.XPAY_SOLANA_SECRET
      ? { solana: rawSolanaSigner({ secretKey: process.env.XPAY_SOLANA_SECRET }) }
      : { solana: placeholderSigner() },
    // Caps are USD — AgenC SOL prices are converted at spot before the check.
    guardrail: { maxPerTx: 2, maxPerDay: 5 },
  });

  console.log(`\n→ Discovering AgenC listings${query ? ` for "${query}"` : ""}...`);
  const results = (await xpay.discover({ query, sources: ["agenc"], limit: 10 })).filter(
    (r) => r.metadata?.source === "agenc",
  );

  if (results.length === 0) {
    console.log("  (no hireable listings right now)");
    return;
  }

  for (const [i, r] of results.entries()) {
    const opt = r.accepts[0];
    const sol = opt?.amount ? (Number(opt.amount) / 1e9).toFixed(4) : "?";
    console.log(`  ${i + 1}. [◎${sol} SOL] ${r.metadata?.name} — ${r.resource}`);
  }

  if (!willHire) {
    console.log("\n(skipping hire — pass --hire to escrow SOL for the cheapest result)");
    return;
  }

  // Hire the cheapest listing — same xpay.use() as an x402 call; the AgenC
  // scheme in accepts[] routes it to the on-chain escrow flow automatically.
  const cheapest = [...results].sort(
    (a, b) => Number(a.accepts[0]?.amount ?? 0) - Number(b.accepts[0]?.amount ?? 0),
  )[0]!;
  console.log(`\n→ Hiring "${cheapest.metadata?.name}"...`);
  const out = await xpay.use(cheapest);
  const receipt = out.data as AgencHireReceipt;

  console.log("  escrowed:", out.amountPaid, "lamports — tx:", out.txSig);
  console.log("  task:    ", receipt.task);
  console.log("  explorer:", receipt.explorer);

  console.log("\n→ Polling task status (snapshot rebuilds ~45s, so this may 404 at first)...");
  try {
    const task = await fetchAgencTask(receipt.task);
    console.log("  status:", task.status);
  } catch (err) {
    console.log(" ", (err as Error).message);
  }
  console.log(`\nCheck later with: xpay agenc status ${receipt.task}`);
}

/** A signer that satisfies the interface but throws on `pay()` — discovery-only. */
function placeholderSigner() {
  return {
    network: "solana" as const,
    address: "11111111111111111111111111111111",
    async signMessage(): Promise<Uint8Array> {
      throw new Error("No real signer configured. Set XPAY_SOLANA_SECRET to hire.");
    },
    async pay(): Promise<string> {
      throw new Error("No real signer configured. Set XPAY_SOLANA_SECRET to hire.");
    },
  };
}

main().catch((err) => {
  console.error("\nFAIL:", err);
  process.exit(1);
});
