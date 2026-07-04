/**
 * Offline AgenC hire E2E — runs the REAL compiled marketplace program
 * in-process via litesvm (no validator, no RPC, no faucet, no SOL spent).
 *
 * Run:
 *   tsx examples/agenc-local-sandbox.ts
 *
 * This proves the exact call shape xpay's `useAgencHire()` uses in
 * src/agenc/hire.ts — `hireFromListingHumanless` with expectedPrice /
 * expectedVersion / listingSpecHash, then task + hireRecord PDA derivation —
 * against real on-chain constraints (moderation gate, escrow, settlement).
 */

import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  facade,
  findAgentPda,
  findHireRecordPda,
  findTaskPda,
  getTaskDecoder,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";

async function main() {
  const t0 = Date.now();
  const market = await startLocalMarketplace();

  const provider = await market.fundedSigner(); // sells the service (worker)
  const buyer = await market.fundedSigner(); // hires it — plays xpay's role
  const providerClient = market.clientFor(provider);
  const buyerClient = market.clientFor(buyer);

  // 1) Register the provider agent and publish a listing (marketplace-side
  //    setup that exists on mainnet already — xpay never does this part).
  const providerAgentId = new Uint8Array(32).fill(1);
  await providerClient.registerAgent({
    authority: provider,
    agentId: providerAgentId,
    capabilities: 1n,
    endpoint: "https://provider.example",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

  const listingId = new Uint8Array(32).fill(3);
  const listingSpecHash = new Uint8Array(32).fill(4);
  const priceLamports = 5_000_000n; // ◎0.005 — mirrors the mainnet canary listing
  await providerClient.createServiceListing({
    providerAgent,
    authority: provider,
    listingId,
    name: new Uint8Array(32).fill(5),
    category: new Uint8Array(32).fill(6),
    tags: new Uint8Array(64).fill(7),
    specHash: listingSpecHash,
    specUri: "agenc://job-spec/sha256/demo",
    price: priceLamports,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  const [listing] = await facade.findListingPda({ providerAgent, listingId });

  // Moderation gate is fail-closed exactly like mainnet — attest the listing.
  await market.moderator.attestListing(listing, listingSpecHash);

  // 2) THE XPAY PATH — identical parameters to useAgencHire() in
  //    src/agenc/hire.ts: humanless hire escrows SOL and pins CreatorReview.
  const taskId = crypto.getRandomValues(new Uint8Array(32));
  await buyerClient.hireFromListingHumanless({
    listing,
    creator: buyer,
    taskId,
    expectedPrice: priceLamports,
    expectedVersion: 1n,
    reviewWindowSecs: 86_400n,
    listingSpecHash,
    moderator: market.moderator.address,
  });
  const [task] = await findTaskPda({ creator: buyer.address, taskId });
  const [hireRecord] = await findHireRecordPda({ task });
  console.log("✔ hire escrowed —", Number(priceLamports) / 1e9, "SOL");
  console.log("  task:      ", task);
  console.log("  hireRecord:", hireRecord);

  // 3) Provider works and the buyer reviews — the async part that happens
  //    after xpay returns its hire receipt on mainnet.
  const jobSpecHash = new Uint8Array(32).fill(9);
  await market.moderator.attestTask(task, jobSpecHash);
  await buyerClient.send([
    await facade.setTaskJobSpec({
      task,
      creator: buyer,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/demo",
      moderator: market.moderator.address,
    }),
  ]);
  await providerClient.claimTaskWithJobSpec({ task, worker: providerAgent, authority: provider });

  const balanceBefore = market.svm.getBalance(provider.address) ?? 0n;
  await providerClient.submitTaskResult({
    task,
    worker: providerAgent,
    authority: provider,
    proofHash: new Uint8Array(32).fill(10),
    resultData: null,
  });
  await buyerClient.acceptTaskResult({
    task,
    worker: providerAgent,
    treasury: market.admin.address,
    creator: buyer,
    workerAuthority: provider.address,
    hireRecord,
  });

  // 4) On-chain assertions: task Completed, worker actually paid from escrow.
  const taskAccount = market.svm.getAccount(task);
  const { status } = getTaskDecoder().decode(Uint8Array.from(taskAccount!.data));
  if (status !== TaskStatus.Completed) throw new Error(`task not completed (status ${status})`);
  const paid = (market.svm.getBalance(provider.address) ?? 0n) - balanceBefore;
  if (paid <= 0n) throw new Error("worker was not paid from escrow");

  console.log("✔ settled — worker received", Number(paid) / 1e9, "SOL from escrow");
  console.log(`\nFull hire lifecycle verified on the real program in ${Date.now() - t0}ms.`);
}

main().catch((err) => {
  console.error("\nFAIL:", err);
  process.exit(1);
});
