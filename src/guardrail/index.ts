/**
 * Spending guardrail — enforced *before* signing so a hallucinating agent
 * can't sneak past it. This is the security primitive that makes xPay
 * "agentic" rather than just "an SDK with a wallet".
 *
 * v0 implements: per-tx cap, per-day cap, allowed host list. v0.2 adds
 * per-counterparty caps and a biometric-required threshold.
 */

import type { PaymentRequirement, Resource } from "../types.js";

export interface GuardrailConfig {
  /** Max USD per single call. */
  maxPerTx?: number;
  /** Max USD across a rolling 24h window. */
  maxPerDay?: number;
  /** Glob-style host whitelist. `["*"]` allows everything. */
  allowedHosts?: string[];
  /** Calls above this USD threshold require an external approval hook. */
  requireApprovalAbove?: number;
  /**
   * Optional callback invoked when {@link GuardrailConfig.requireApprovalAbove}
   * is hit. Implementor decides how to surface the prompt (biometric, push,
   * webhook). Resolve `true` to allow, `false` to deny.
   */
  onApprovalRequired?: (ctx: { resource: Resource; usd: number }) => Promise<boolean>;
}

interface SpendEntry {
  at: number;
  usd: number;
}

export class Guardrail {
  private readonly config: GuardrailConfig;
  private readonly history: SpendEntry[] = [];

  constructor(config: GuardrailConfig = {}) {
    this.config = config;
  }

  /**
   * Check a pending call. Throws if blocked.
   * Called by {@link use} before any on-chain action.
   */
  async check(args: { resource: Resource; requirement: PaymentRequirement }): Promise<void> {
    const usd = estimateUsd(args.requirement);

    // Host whitelist. Skipped for direct transfers (they target addresses, not
    // hosts) — amount caps still apply, so a leaked CLI can't drain the wallet.
    if (
      args.resource.type !== "transfer" &&
      this.config.allowedHosts &&
      this.config.allowedHosts.length > 0
    ) {
      const allowed = this.config.allowedHosts;
      if (!allowed.includes("*")) {
        const host = safeHost(args.resource.resource);
        const ok = allowed.some((pattern) => hostMatches(host, pattern));
        if (!ok) {
          throw new GuardrailError(`Host "${host}" is not in the allowed list`);
        }
      }
    }

    // Per-tx cap.
    if (this.config.maxPerTx !== undefined && usd > this.config.maxPerTx) {
      throw new GuardrailError(
        `Single call would spend $${usd.toFixed(4)}, exceeds maxPerTx $${this.config.maxPerTx}`,
      );
    }

    // Per-day cap.
    if (this.config.maxPerDay !== undefined) {
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const spent = this.history.filter((h) => h.at >= dayAgo).reduce((s, h) => s + h.usd, 0);
      if (spent + usd > this.config.maxPerDay) {
        throw new GuardrailError(
          `Daily spend $${(spent + usd).toFixed(4)} would exceed maxPerDay $${this.config.maxPerDay}`,
        );
      }
    }

    // Approval gate.
    if (
      this.config.requireApprovalAbove !== undefined &&
      usd >= this.config.requireApprovalAbove
    ) {
      if (!this.config.onApprovalRequired) {
        throw new GuardrailError(
          `Call requires approval ($${usd.toFixed(4)} >= $${this.config.requireApprovalAbove}) but no onApprovalRequired hook is configured`,
        );
      }
      const approved = await this.config.onApprovalRequired({ resource: args.resource, usd });
      if (!approved) {
        throw new GuardrailError(`Call denied by approval hook`);
      }
    }

    this.history.push({ at: Date.now(), usd });
  }

  /** Sum of recent spend, in USD, within the last 24h. */
  recentSpend(): number {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return this.history.filter((h) => h.at >= dayAgo).reduce((s, h) => s + h.usd, 0);
  }
}

export class GuardrailError extends Error {
  constructor(message: string) {
    super(`xpay guardrail: ${message}`);
    this.name = "GuardrailError";
  }
}

/**
 * Best-effort USD estimate. Assumes USDC (6 decimals) on Solana, USDC (6) on
 * Base/EVM. Future versions should consult a price oracle for non-USDC assets.
 */
function estimateUsd(req: PaymentRequirement): number {
  if (!req.amount) return 0;
  // USDC has 6 decimals on every chain we currently support.
  return Number(req.amount) / 1_000_000;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix);
  }
  return false;
}
