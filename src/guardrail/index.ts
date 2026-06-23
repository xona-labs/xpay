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
   * is hit — *or* when Bento escalates a call for human review. Implementor
   * decides how to surface the prompt (biometric, push, webhook). Resolve
   * `true` to allow, `false` to deny.
   */
  onApprovalRequired?: (ctx: { resource: Resource; usd: number }) => Promise<boolean>;
  /**
   * Bento Guard intent firewall. When `enabled`, each call is screened by
   * Bento's `protect()` (prompt-injection / wallet-drain / intent analysis)
   * *after* the local caps pass and *before* signing. Requires the wallet to
   * be registered at https://app.bentoguard.xyz and `AGENT_WALLET_PRIVATE_KEY`
   * in the environment — `createXPay` sets that automatically from the active
   * profile. A `BLOCKED` verdict throws; an `ESCALATED` verdict defers to
   * {@link GuardrailConfig.onApprovalRequired} (or fails closed if none is set).
   */
  bento?: {
    enabled?: boolean;
    /** Per-call timeout for the Bento relayer round-trip. Default 8000ms. */
    timeoutMs?: number;
  };
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

    // Bento intent firewall. Runs last — it's a network round-trip to the
    // Bento relayer, so the cheap deterministic checks above reject the
    // obvious cases first. Only fires when explicitly enabled.
    if (this.config.bento?.enabled) {
      await this.checkBento(args.resource, usd);
    }

    this.history.push({ at: Date.now(), usd });
  }

  /**
   * Screen a pending call through Bento's `protect()`. Bento analyses *intent*
   * (prompt-injection, wallet-drain, intent-vs-execution mismatch) and returns
   * a verdict. We translate that verdict into the guardrail's own outcomes:
   *   - ALLOW     → return (call proceeds)
   *   - BLOCKED   → throw
   *   - ESCALATED → defer to onApprovalRequired, else fail closed
   */
  private async checkBento(resource: Resource, usd: number): Promise<void> {
    const { protect } = await loadBento();

    let verdict: BentoVerdict;
    try {
      verdict = await protect(describeSpend(resource, usd), {
        autoPollEscalation: false,
        timeout: this.config.bento?.timeoutMs ?? 8000,
        silent: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The most common first-run failure: the agent wallet hasn't been
      // registered in the Bento Dashboard. The relayer reports this as
      // "Agent not found" / "Agent security check failed" (confirmed against
      // the live relayer). Surface the fix instead of a raw error.
      if (/agent not found|security check failed|not\s+(?:been\s+)?registered/i.test(msg)) {
        throw new GuardrailError(
          "Bento is enabled but this agent wallet isn't registered. Log in to " +
            "https://app.bentoguard.xyz with your owner wallet and register this agent " +
            "address, then retry — or run `xpay bento disable`.",
        );
      }
      throw new GuardrailError(`Bento intent check failed: ${msg}`);
    }

    if (verdict.recommendation === "BLOCKED") {
      const risk = verdict.riskScore !== undefined ? ` (risk ${verdict.riskScore}/100)` : "";
      throw new GuardrailError(
        `Bento blocked this call — ${verdict.reasoning ?? "flagged as malicious intent"}${risk}`,
      );
    }

    if (verdict.recommendation === "ESCALATED") {
      // Ambiguous call. Reuse the same human-in-the-loop hook the local
      // guardrail uses for its approval threshold.
      if (this.config.onApprovalRequired) {
        const approved = await this.config.onApprovalRequired({ resource, usd });
        if (!approved) {
          const where = verdict.reviewUrl ? ` (${verdict.reviewUrl})` : "";
          throw new GuardrailError(`Bento escalated this call and it was not approved${where}`);
        }
        return;
      }
      // No approver wired — fail closed (treat ambiguous as blocked).
      const where = verdict.approveUrl ? ` — approve at ${verdict.approveUrl}` : "";
      throw new GuardrailError(
        `Bento escalated this call for human review${where}. Configure an ` +
          "onApprovalRequired hook to handle escalations, or run `xpay bento disable`.",
      );
    }
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

/**
 * Render a pending spend as the natural-language instruction Bento's
 * `protect()` expects. Bento screens *intent*, so we describe what the call
 * does in plain terms — amount, destination, and whether it's a service call
 * or a direct transfer (the case most prone to a drain attempt).
 */
function describeSpend(resource: Resource, usd: number): string {
  const amount = usd > 0 ? `$${usd.toFixed(usd < 0.01 ? 6 : 2)} USDC` : "an unspecified amount";
  if (resource.type === "transfer") {
    // Transfer resource URLs look like xpay://transfer/<network>/<address>.
    const to = resource.resource.split("/").filter(Boolean).pop() ?? "an unknown address";
    return `Transfer ${amount} directly to wallet address ${to}.`;
  }
  const host = safeHost(resource.resource) || resource.resource;
  return `Pay ${amount} to call the paid API at ${host} (${resource.method} ${resource.resource}).`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// -----------------------------------------------------------------------------
// Bento SDK — loaded lazily so the optional native dependency is only required
// when a profile actually enables the firewall.
// -----------------------------------------------------------------------------

interface BentoVerdict {
  recommendation: "ALLOW" | "BLOCKED" | "ESCALATED" | string;
  riskScore?: number;
  reasoning?: string;
  actionId?: string;
  approveUrl?: string;
  blockUrl?: string;
  reviewUrl?: string;
}

interface BentoModule {
  protect(instruction: string, options?: Record<string, unknown>): Promise<BentoVerdict>;
}

let bentoModule: BentoModule | null = null;

async function loadBento(): Promise<BentoModule> {
  if (bentoModule) return bentoModule;
  // Non-literal specifier keeps TypeScript from resolving the optional package
  // at build time — it may not be installed in every environment.
  const specifier = "@bentoguard/sdk";
  try {
    bentoModule = (await import(specifier)) as unknown as BentoModule;
  } catch {
    throw new GuardrailError(
      "Bento is enabled but @bentoguard/sdk could not be loaded. Install it with " +
        "`npm i @bentoguard/sdk` (Node 18+), or run `xpay bento disable`.",
    );
  }
  return bentoModule;
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix);
  }
  return false;
}
