/**
 * Read-only demo: find a Solana token by ticker, then quote a swap into it.
 * No funds move — quoting needs a wallet address (Jupiter's `taker`) but no
 * signature. To actually swap, use `xpay swap 0.01 SOL BONK` with a funded
 * profile, or xpay.swap() with a real signer.
 *
 * Run:
 *   tsx examples/token-swap-quote.ts [--query=BONK]
 */

import "dotenv/config";
import { createXPay, findTokens, rawSolanaSigner } from "../src/index.js";

async function main() {
  const query = process.argv.find((a) => a.startsWith("--query="))?.slice(8) ?? "BONK";

  console.log(`\n→ Finding tokens for "${query}"...`);
  const tokens = await findTokens(query, { limit: 5 });
  for (const [i, t] of tokens.entries()) {
    const price = t.usdPrice !== undefined ? `$${t.usdPrice.toPrecision(4)}` : "?";
    console.log(
      `  ${i + 1}. ${t.symbol.padEnd(10)} ${price.padEnd(12)} ${t.verified ? "verified" : "UNVERIFIED"}  ${t.mint}`,
    );
  }
  const target = tokens.find((t) => t.verified);
  if (!target) {
    console.log("  (no verified match — not quoting)");
    return;
  }

  const xpay = createXPay({
    networks: ["solana"],
    signers: process.env.XPAY_SOLANA_SECRET
      ? { solana: rawSolanaSigner({ secretKey: process.env.XPAY_SOLANA_SECRET }) }
      : { solana: quoteOnlySigner() },
  });

  console.log(`\n→ Quoting 0.01 SOL → ${target.symbol} (by mint)...`);
  const q = await xpay.swapQuote({ amount: 0.01, from: "SOL", to: target.mint });
  const usd = q.usdValue !== undefined ? ` (~$${q.usdValue.toFixed(2)})` : "";
  console.log(`  ${q.inAmount} SOL${usd} → ~${q.outAmount.toLocaleString()} ${q.to.symbol}`);
  console.log(`  router ${q.router}, slippage ${q.slippageBps ?? "dynamic"} bps`);
  console.log("\n(quote only — run `xpay swap 0.01 SOL " + target.symbol + "` to execute)");
}

/** Quoting needs a real, funded address as taker — but never signs. */
function quoteOnlySigner() {
  return {
    network: "solana" as const,
    // Any funded mainnet address works for quotes; swaps require your own key.
    address: "ATShdVRzRGcirtgHGR5XrUbk1s3QhXzp8e6TCi9qnHpi",
    async signMessage(): Promise<Uint8Array> {
      throw new Error("Quote-only signer. Set XPAY_SOLANA_SECRET to swap.");
    },
    async pay(): Promise<string> {
      throw new Error("Quote-only signer. Set XPAY_SOLANA_SECRET to swap.");
    },
  };
}

main().catch((err) => {
  console.error("\nFAIL:", err);
  process.exit(1);
});
