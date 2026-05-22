/**
 * Unified history shape across networks. One entry per USDC transfer in or
 * out of the wallet.
 *
 * v1 only surfaces USDC because that's what xPay actually transacts in
 * (x402 is USDC-denominated). Future versions can extend `asset` to other
 * tokens or even non-fungible payments.
 */

import type { Network } from "../types.js";

export interface HistoryEntry {
  /** Unix ms timestamp the tx was confirmed (best-effort). */
  timestamp: number | null;
  /** Network the tx happened on. */
  network: Network;
  /** Settlement signature / tx hash. */
  signature: string;
  /** "send" when wallet was the sender, "receive" when the receiver. */
  direction: "send" | "receive";
  /** Other side of the transfer. */
  counterparty: string;
  /** Human USDC amount (positive, with 6-decimal precision). */
  amountUsdc: number;
  /** "confirmed" / "finalized" / "failed" — best-effort, may be undefined. */
  status?: string;
}
