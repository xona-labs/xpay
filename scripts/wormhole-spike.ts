/**
 * Spike: exercise guardrail.wormhole against real signed x402 v2 payloads.
 * Throwaway keys, nothing is sent to any merchant. SVM case needs a Solana
 * RPC (blockhash only); EVM cases are fully offline.
 *
 *   npx tsx scripts/wormhole-spike.ts
 */
import { Keypair } from "@solana/web3.js";
import { Wallet } from "ethers";
import { Guardrail } from "../src/guardrail/index.js";
import { buildEvmPaymentHeader } from "../src/x402/evm-payment.js";
import { buildSvmPaymentHeader } from "../src/x402/svm-payment.js";
import { rawSolanaSigner } from "../src/signers/raw-solana.js";
import type { PaymentRequirement, Resource } from "../src/types.js";

const resource = { resource: "https://api.example.com/x", method: "GET", type: "http", accepts: [] } as unknown as Resource;
const g = (onAbstain: "fallback" | "approve" | "block" = "block") => new Guardrail({ wormhole: { enabled: true, onAbstain } });
/** What every user gets: no wormhole config at all. */
const dflt = () => new Guardrail({ maxPerTx: 1 });

async function expect(label: string, fn: () => Promise<void>, want: "allow" | "block") {
  try {
    await fn();
    console.log(`${want === "allow" ? "PASS" : "FAIL"}  ${label}: allowed`);
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`${want === "block" ? "PASS" : "FAIL"}  ${label}: blocked -> ${msg.slice(0, 220)}`);
  }
}

// ---------------- EVM (Base USDC, offline)
const evm = Wallet.createRandom();
const signTypedData = ({ domain, types, message }: any) => evm.signTypedData(domain, types, message);
const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const baseReq: PaymentRequirement = {
  scheme: "exact", network: "eip155:8453", payTo: MERCHANT, amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
} as PaymentRequirement;

const evmHeader = await buildEvmPaymentHeader({ address: evm.address, signTypedData, requirement: baseReq });
await expect("EVM base, matching quote", () => g().verifyPayment({ resource, requirement: baseReq, header: evmHeader, payer: evm.address }), "allow");
await expect("EVM base, quote says different payee", () => g().verifyPayment({ resource, requirement: { ...baseReq, payTo: ATTACKER }, header: evmHeader, payer: evm.address }), "block");
await expect("EVM base, quote says lower amount", () => g().verifyPayment({ resource, requirement: { ...baseReq, amount: "1000" }, header: evmHeader, payer: evm.address }), "block");
await expect("EVM base, foreign payer", () => g().verifyPayment({ resource, requirement: baseReq, header: evmHeader, payer: Wallet.createRandom().address }), "block");

// Malicious 402: wrong EIP-712 domain name. Our builder trusts extra.name, Wormhole uses its own table.
const badDomainReq = { ...baseReq, extra: { name: "USDC", version: "1" } } as PaymentRequirement;
const badDomainHeader = await buildEvmPaymentHeader({ address: evm.address, signTypedData, requirement: badDomainReq });
await expect("EVM base, merchant-supplied bogus domain", () => g().verifyPayment({ resource, requirement: badDomainReq, header: badDomainHeader, payer: evm.address }), "block");

// Replay: same guardrail sees same nonce twice.
const gr = g();
await gr.verifyPayment({ resource, requirement: baseReq, header: evmHeader, payer: evm.address });
await expect("EVM base, nonce replay in session", () => gr.verifyPayment({ resource, requirement: baseReq, header: evmHeader, payer: evm.address }), "block");

// SKALE USDC.e: not in Wormhole's trusted domain table -> abstain.
const skaleReq = { ...baseReq, network: "skale", asset: "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20", extra: { name: "Bridged USDC (SKALE Bridge)", version: "2" } } as PaymentRequirement;
const skaleHeader = await buildEvmPaymentHeader({ address: evm.address, signTypedData, requirement: skaleReq });
await expect("EVM skale, onAbstain=block", () => g("block").verifyPayment({ resource, requirement: skaleReq, header: skaleHeader, payer: evm.address }), "block");
await expect("EVM skale, onAbstain=fallback", () => g("fallback").verifyPayment({ resource, requirement: skaleReq, header: skaleHeader, payer: evm.address }), "allow");

// Default config (no wormhole key): on, refuse blocks, abstain falls back.
await expect("DEFAULT base, matching quote", () => dflt().verifyPayment({ resource, requirement: baseReq, header: evmHeader, payer: evm.address }), "allow");
await expect("DEFAULT base, different payee", () => dflt().verifyPayment({ resource, requirement: { ...baseReq, payTo: ATTACKER }, header: evmHeader, payer: evm.address }), "block");
const d = dflt();
await expect("DEFAULT skale, falls back to local guardrail", () => d.verifyPayment({ resource, requirement: skaleReq, header: skaleHeader, payer: evm.address }), "allow");
await expect("DEFAULT skale, second call (warning not repeated)", () => d.verifyPayment({ resource, requirement: skaleReq, header: skaleHeader, payer: evm.address }), "allow");
await expect("DISABLED, mismatch passes through", () => new Guardrail({ wormhole: { enabled: false } }).verifyPayment({ resource, requirement: { ...baseReq, payTo: ATTACKER }, header: evmHeader, payer: evm.address }), "allow");

// ---------------- SVM (Solana USDC, needs RPC for blockhash)
const kp = Keypair.generate();
const sol = rawSolanaSigner({ secretKey: kp.secretKey });
const svmReq = {
  scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "10000",
  payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", maxTimeoutSeconds: 300,
  extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
} as unknown as PaymentRequirement;
try {
  const svmHeader = await buildSvmPaymentHeader({ kitSigner: await sol.getKitSigner!(), requirement: svmReq });
  await expect("SVM usdc, matching quote", () => g().verifyPayment({ resource, requirement: svmReq, header: svmHeader, payer: sol.address }), "allow");
  await expect("SVM usdc, quote says different payee", () => g().verifyPayment({ resource, requirement: { ...svmReq, payTo: "So11111111111111111111111111111111111111112" }, header: svmHeader, payer: sol.address }), "block");
  await expect("SVM usdc, quote says lower amount", () => g().verifyPayment({ resource, requirement: { ...svmReq, amount: "1" }, header: svmHeader, payer: sol.address }), "block");
  await expect("DEFAULT svm, different payee", () => dflt().verifyPayment({ resource, requirement: { ...svmReq, payTo: "So11111111111111111111111111111111111111112" }, header: svmHeader, payer: sol.address }), "block");
  await expect("SVM usdc, foreign payer", () => g().verifyPayment({ resource, requirement: svmReq, header: svmHeader, payer: Keypair.generate().publicKey.toBase58() }), "block");
} catch (e) {
  console.log("SKIP  SVM cases:", (e as Error).message);
}
