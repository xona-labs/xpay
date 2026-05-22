/**
 * End-to-end demo: discover services across PayAI, then (optionally) pay one.
 *
 * Run:
 *   tsx examples/discover-and-pay.ts
 *
 * With a real signer (uses real USDC, be careful):
 *   XPAY_SOLANA_SECRET=<base58> tsx examples/discover-and-pay.ts --pay
 */

import "dotenv/config";
import { createXPay, rawSolanaSigner } from "../src/index.js";

async function main() {
  const willPay = process.argv.includes("--pay");
  const query = process.argv.find((a) => a.startsWith("--query="))?.slice(8) ?? "weather";

  // Build a client. If no signer env is set, we use a placeholder address —
  // discovery still works (it's read-only), but `use` would fail.
  const xpay = createXPay({
    networks: ["solana", "base"],
    signers: process.env.XPAY_SOLANA_SECRET
      ? { solana: rawSolanaSigner({ secretKey: process.env.XPAY_SOLANA_SECRET }) }
      : { solana: placeholderSigner() },
    guardrail: { maxPerTx: 0.5, maxPerDay: 5 },
  });

  console.log(`\n→ Discovering services for "${query}"...`);
  const results = await xpay.discover({ query, limit: 5 });

  if (results.length === 0) {
    console.log("  (no matches)");
    return;
  }

  for (const [i, r] of results.entries()) {
    const opt = r.accepts[0];
    const usd = opt?.amount ? (Number(opt.amount) / 1_000_000).toFixed(4) : "?";
    console.log(`  ${i + 1}. [$${usd} on ${opt?.network ?? "?"}] ${r.resource}`);
  }

  if (!willPay) {
    console.log("\n(skipping payment — pass --pay to actually call the top result)");
    return;
  }

  console.log(`\n→ Calling ${results[0]!.resource}...`);
  const out = await xpay.use(results[0]!);
  console.log("  status:", out.status);
  console.log("  paid:  ", out.amountPaid, "on", out.network, "tx:", out.txSig);
  console.log("  body:  ", JSON.stringify(out.data).slice(0, 200));
}

/** A signer that satisfies the interface but throws on `pay()` — discovery-only. */
function placeholderSigner() {
  return {
    network: "solana" as const,
    address: "11111111111111111111111111111111",
    async signMessage() {
      throw new Error("No real signer configured. Set XPAY_SOLANA_SECRET to pay.");
    },
    async pay() {
      throw new Error("No real signer configured. Set XPAY_SOLANA_SECRET to pay.");
    },
  };
}

main().catch((err) => {
  console.error("\nFAIL:", err);
  process.exit(1);
});
