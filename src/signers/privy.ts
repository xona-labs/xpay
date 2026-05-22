/**
 * Privy signer adapter (stub).
 *
 * Privy is `@xona-labs/xpay`'s recommended production custody. The adapter
 * accepts a Privy wallet client and exposes our {@link Signer} interface.
 *
 * Stubbed in v0 because the implementation depends on whether the consumer
 * uses the React SDK (`@privy-io/react-auth`) or the Node SDK
 * (`@privy-io/server-sdk`). The full implementation lands when we publish
 * `@xona-labs/xpay-react` and a dedicated server adapter.
 */

import type { Signer } from "../types.js";

export interface PrivySignerOptions {
  /** Privy wallet client (shape varies by SDK). */
  wallet: unknown;
  /** Network this signer is bound to. */
  network: string;
}

export function privySigner(_opts: PrivySignerOptions): Signer {
  throw new Error(
    "privySigner is not implemented yet. Track progress in @xona-labs/xpay-react.",
  );
}
