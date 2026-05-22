/**
 * Phantom browser-wallet signer (stub).
 *
 * Real implementation requires the browser `window.solana` provider. This
 * stub keeps the import surface stable and documents the contract; the
 * implementation lands when xpay-react is added.
 */

import type { Signer } from "../types.js";

export interface PhantomSignerOptions {
  /** Override the provider for tests. Defaults to `window.solana`. */
  provider?: unknown;
}

export function phantomSigner(_opts: PhantomSignerOptions = {}): Signer {
  throw new Error(
    "phantomSigner is not implemented yet. Use rawSolanaSigner for server-side use, " +
      "or wait for @xona-labs/xpay-react which will ship a browser-ready Phantom adapter.",
  );
}
