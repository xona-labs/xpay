/**
 * Do — the thesis in one method. Discover by intent, pick the top result, use it.
 *
 * This is the API normies (and most agents) actually want. Power users compose
 * {@link discover} + {@link use} manually when they need control over picking.
 */

import type { UseResult } from "../types.js";
import { discover } from "../discover/index.js";
import { use } from "../use/index.js";
import type { Wallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";
import type { AgencHireConfig } from "../agenc/hire.js";

export interface DoArgs {
  query: string;
  wallet: Wallet;
  guardrail: Guardrail;
  body?: unknown;
  /** AgenC hire settings — forwarded to `use()` when the top match is an AgenC listing. */
  agenc?: AgencHireConfig;
}

export async function doIt(args: DoArgs): Promise<UseResult> {
  const candidates = await discover({
    query: args.query,
    networks: args.wallet.networks,
    limit: 5,
  });

  if (candidates.length === 0) {
    throw new Error(`xpay.do: no services found for "${args.query}"`);
  }

  // v0 picks the top-ranked match the wallet can actually pay. v0.2 should
  // rerank by reliability + price; v1 should learn from user history.
  for (const candidate of candidates) {
    if (args.wallet.pickRequirement(candidate.accepts)) {
      return use({
        resource: candidate,
        wallet: args.wallet,
        guardrail: args.guardrail,
        body: args.body,
        agenc: args.agenc,
      });
    }
  }

  throw new Error(
    `xpay.do: found ${candidates.length} services for "${args.query}" but none accept payment on configured networks (${args.wallet.networks.join(", ")})`,
  );
}
