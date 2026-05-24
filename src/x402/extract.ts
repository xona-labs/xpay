/**
 * Extract x402 payment requirements from a 402 response.
 *
 * The x402 ecosystem is inconsistent about both WHERE and in WHAT SHAPE the
 * challenge lives, so this is deliberately tolerant:
 *
 *   location: response body, or a header (Payment-Required, X-Payment, ...)
 *   shape:    a bare array, an `{ accepts: [...] }` / `{ items: [...] }`
 *             envelope, or a SINGLE bare requirement object
 *   encoding: raw JSON, base64-JSON, url-encoded JSON, or "<scheme> <payload>"
 *   fields:   PayAI uses `amount`/`payTo`; the x402 spec uses
 *             `maxAmountRequired`/`payTo`; others use `recipient`/`token` —
 *             we alias them all into our PaymentRequirement.
 *
 * Shared by `probe()` and `useByUrl()`.
 */

import type { PaymentRequirement } from "../types.js";

export interface ExtractedRequirements {
  accepts: PaymentRequirement[];
  source?: "body" | "header";
  x402Version?: number;
}

/** Header names seen carrying x402 payment requirements, in priority order. */
const HEADER_CANDIDATES = [
  "payment-required",
  "x-payment-required",
  "x-payment",
  "x-accept-payment",
  "accept-payment",
  "x-402",
  "www-authenticate",
];

export function extractRequirements(headers: Headers, body: unknown): ExtractedRequirements {
  // 1. body
  const fromBody = parseChallenge(body);
  if (fromBody.length > 0) {
    return { accepts: fromBody, source: "body", x402Version: detectVersion(body) };
  }

  // 2. headers
  for (const name of HEADER_CANDIDATES) {
    const raw = headers.get(name);
    if (!raw) continue;
    const decoded = decodeHeaderValue(raw);
    const accepts = parseChallenge(decoded);
    if (accepts.length > 0) {
      return { accepts, source: "header", x402Version: detectVersion(decoded) };
    }
  }

  return { accepts: [] };
}

/** Best-effort decode of a header value into a JS value. */
function decodeHeaderValue(raw: string): unknown {
  const tryJson = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const tryB64 = (s: string) => {
    try {
      return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  };
  const tryUrl = (s: string) => {
    try {
      return JSON.parse(decodeURIComponent(s));
    } catch {
      return undefined;
    }
  };

  return (
    tryJson(raw) ??
    tryB64(raw) ??
    tryUrl(raw) ??
    // "<scheme> <payload>" e.g. `X402 eyJ...` or `Bearer {...}`
    (() => {
      const parts = raw.split(/\s+/);
      if (parts.length === 2) return tryB64(parts[1]!) ?? tryJson(parts[1]!) ?? tryUrl(parts[1]!);
      return undefined;
    })() ??
    raw
  );
}

/**
 * Parse a challenge payload into PaymentRequirement[]. Tolerant of arrays,
 * envelopes, single objects, and field-name variants.
 */
export function parseChallenge(data: unknown): PaymentRequirement[] {
  return toCandidateArray(data)
    .map(normalizeRequirement)
    .filter((r): r is PaymentRequirement => r !== null);
}

function toCandidateArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isObj);
  if (isObj(data)) {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.accepts)) return (o.accepts as unknown[]).filter(isObj) as Record<string, unknown>[];
    if (Array.isArray(o.items)) return (o.items as unknown[]).filter(isObj) as Record<string, unknown>[];
    // a single bare requirement object?
    if (looksLikeRequirement(o)) return [o];
  }
  return [];
}

function looksLikeRequirement(o: Record<string, unknown>): boolean {
  return Boolean(
    o.scheme ||
      o.network ||
      o.chain ||
      o.chainId ||
      o.payTo ||
      o.recipient ||
      o.amount ||
      o.maxAmountRequired,
  );
}

/** Map a loose requirement-ish object into our PaymentRequirement, aliasing field names. */
function normalizeRequirement(o: Record<string, unknown>): PaymentRequirement | null {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (o[k] != null) return o[k];
    return undefined;
  };
  const network = pick("network", "chain", "chainId");
  const payTo = pick("payTo", "recipient", "payToAddress", "to", "address");
  const asset = pick("asset", "token", "currency", "mint", "contract");
  const amount = pick("amount", "maxAmountRequired", "maxAmount", "price", "priceAtomic");
  const scheme = pick("scheme") ?? "exact";

  // Need at least a network or a recipient to be a usable requirement.
  if (network == null && payTo == null) return null;

  return {
    scheme: String(scheme),
    network: String(network ?? ""),
    payTo: String(payTo ?? ""),
    asset: asset != null ? String(asset) : "",
    amount: amount != null ? String(amount) : undefined,
    maxTimeoutSeconds: typeof o.maxTimeoutSeconds === "number" ? o.maxTimeoutSeconds : undefined,
    mimeType: typeof o.mimeType === "string" ? o.mimeType : undefined,
    extra: isObj(o.extra) ? (o.extra as Record<string, unknown>) : undefined,
  };
}

export function detectVersion(data: unknown): number | undefined {
  if (isObj(data)) {
    const v = (data as { x402Version?: unknown }).x402Version;
    if (typeof v === "number") return v;
    if ("accepts" in (data as object)) return 2;
  }
  if (Array.isArray(data)) return 1;
  return undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
