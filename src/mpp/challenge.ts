/**
 * Parse MPP (Machine Payments Protocol) challenges from a 402 response.
 *
 * MPP is the Stripe + Tempo open standard for HTTP 402 (spec: mpp.dev /
 * paymentauth.org). Unlike x402's custom headers, the challenge rides the
 * standard auth header:
 *
 *   WWW-Authenticate: Payment id="...", realm="...", method="evm",
 *       intent="charge", request="<base64url JSON>", expires="..."
 *
 * A server may offer several payment methods; fetch() merges the multiple
 * WWW-Authenticate headers into one comma-separated value, so the parser
 * splits on `Payment ` scheme boundaries outside quoted strings (RFC 9110
 * 11.6.1), then reads auth-params with quoted-string escape handling.
 *
 * The raw base64url `request` and `opaque` values are kept verbatim: the
 * server HMAC-binds the challenge `id` to their exact encoding, so the
 * credential must echo them unmodified.
 */

import type { PaymentRequirement } from "../types.js";

export interface MppChallenge {
  id: string;
  realm: string;
  /** Payment method, e.g. "evm", "tempo", "solana", "stripe". */
  method: string;
  /** Intent, e.g. "charge", "session", "subscription". */
  intent: string;
  /** Decoded method-specific request payload. */
  request: Record<string, unknown>;
  /** Raw base64url `request` exactly as received - echo verbatim in the credential. */
  requestRaw: string;
  description?: string;
  digest?: string;
  expires?: string;
  /** Raw base64url server correlation data - clients MUST NOT modify. */
  opaque?: string;
}

/** One settleable payment option: the challenge plus its derived requirement. */
export interface MppOption {
  challenge: MppChallenge;
  requirement: PaymentRequirement;
}

/**
 * Extract every MPP `Payment` challenge from a 402 response's headers.
 * Returns [] when the header is absent or carries no Payment scheme, so
 * callers can cheaply detect "is this an MPP server at all".
 */
export function parseMppChallenges(headers: Headers): MppChallenge[] {
  const header = headers.get("www-authenticate");
  if (!header) return [];

  const out: MppChallenge[] = [];
  for (const chunk of splitPaymentSchemes(header)) {
    const ch = parseOne(chunk);
    if (ch) out.push(ch);
  }
  return out;
}

/**
 * Filter challenges down to the options this wallet stack can actually
 * settle today, mapped into {@link PaymentRequirement} so balance-aware
 * picking and the guardrail reuse the x402 machinery unchanged.
 *
 * Currently settleable:
 *   - `evm`/`charge` paying a known EIP-3009 token (signed
 *     transferWithAuthorization, server broadcasts)
 *   - `tempo`/`charge` (signed pull-mode Tempo transaction, server
 *     broadcasts; fee-sponsored when the challenge offers feePayer)
 * `solana` uses signed-transaction payloads and lands with its chain
 * support, not here.
 */
export function settleableMppOptions(challenges: MppChallenge[]): MppOption[] {
  const out: MppOption[] = [];
  for (const ch of challenges) {
    if (ch.intent !== "charge" || (ch.method !== "evm" && ch.method !== "tempo")) continue;
    const req = ch.method === "tempo" ? tempoChargeToRequirement(ch) : evmChargeToRequirement(ch);
    if (req) out.push({ challenge: ch, requirement: req });
  }
  return out;
}

/**
 * Map an MPP tempo/charge request into our PaymentRequirement shape.
 * Tempo requests look like EVM ones (amount/currency/recipient +
 * methodDetails.chainId) but settle via signed Tempo transactions, and the
 * chainId may be omitted (mainnet, 4217).
 */
function tempoChargeToRequirement(ch: MppChallenge): PaymentRequirement | null {
  const r = ch.request;
  const details = isObj(r.methodDetails) ? r.methodDetails : {};
  const chainId = typeof details.chainId === "number" ? details.chainId : 4217;
  if (typeof r.currency !== "string" || typeof r.recipient !== "string") return null;
  // xpay signs pull-mode (sign, server broadcasts) - skip push-only challenges.
  const modes = details.supportedModes;
  if (Array.isArray(modes) && !modes.includes("pull")) return null;

  return {
    scheme: "exact",
    network: `eip155:${chainId}`,
    payTo: r.recipient,
    asset: r.currency,
    amount: typeof r.amount === "string" ? r.amount : undefined,
    maxTimeoutSeconds: secondsUntil(ch.expires),
  };
}

/** Map an MPP evm/charge request into our PaymentRequirement shape. */
function evmChargeToRequirement(ch: MppChallenge): PaymentRequirement | null {
  const r = ch.request;
  const details = isObj(r.methodDetails) ? r.methodDetails : {};
  const chainId = details.chainId;
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) return null;
  if (typeof r.currency !== "string" || typeof r.recipient !== "string") return null;

  // credentialTypes, when present, must include the one payload we sign.
  const types = details.credentialTypes;
  if (Array.isArray(types) && !types.includes("authorization")) return null;
  // Split payouts need multiple transfers - a single EIP-3009 signature can't.
  if (Array.isArray(details.splits) && details.splits.length > 0) return null;

  return {
    scheme: "exact",
    network: `eip155:${chainId}`,
    payTo: r.recipient,
    asset: r.currency,
    amount: typeof r.amount === "string" ? r.amount : undefined,
    maxTimeoutSeconds: secondsUntil(ch.expires),
  };
}

function secondsUntil(expires: string | undefined): number | undefined {
  if (!expires) return undefined;
  const ms = Date.parse(expires) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

/**
 * Split a (possibly merged) WWW-Authenticate value into `Payment ...` chunks,
 * ignoring scheme-like tokens inside quoted strings. Non-Payment schemes
 * (Bearer, Basic, ...) are dropped.
 */
function splitPaymentSchemes(header: string): string[] {
  const starts: number[] = [];
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i]!;
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inQuotes = false;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (!isPaymentSchemeAt(header, i)) continue;
    // A scheme may only start at the beginning or after a comma (RFC 9110).
    let b = i - 1;
    while (b >= 0 && /\s/.test(header[b]!)) b--;
    if (b >= 0 && header[b] !== ",") continue;
    starts.push(i);
  }

  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : header.length;
    return header
      .slice(start + "payment".length, end)
      .replace(/,\s*$/, "")
      .trim();
  });
}

function isPaymentSchemeAt(header: string, i: number): boolean {
  if (header.slice(i, i + 7).toLowerCase() !== "payment") return false;
  const next = header[i + 7];
  return Boolean(next && /\s/.test(next));
}

/** Parse one scheme chunk's auth-params into a challenge. null when malformed. */
function parseOne(chunk: string): MppChallenge | null {
  let params: Record<string, string>;
  try {
    params = parseAuthParams(chunk);
  } catch {
    return null;
  }

  const { id, realm, method, intent, request } = params;
  if (!id || !realm || !method || !intent || !request) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(request, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(decoded)) return null;

  return {
    id,
    realm,
    method,
    intent,
    request: decoded,
    requestRaw: request,
    description: params.description,
    digest: params.digest,
    expires: params.expires,
    opaque: params.opaque,
  };
}

/** Auth-param parser with escaped quoted-string support. */
function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i]!)) i++;
    if (i >= input.length) break;

    const keyStart = i;
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i]!)) i++;
    const key = input.slice(keyStart, i);
    if (!key) throw new Error("malformed auth-param");

    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (input[i] !== "=") break; // token without '=': likely another scheme
    i++;
    while (i < input.length && /\s/.test(input[i]!)) i++;

    let value: string;
    if (input[i] === '"') {
      [value, i] = readQuoted(input, i + 1);
    } else {
      const start = i;
      while (i < input.length && input[i] !== ",") i++;
      value = input.slice(start, i).trim();
    }
    result[key] = value;
  }
  return result;
}

function readQuoted(input: string, start: number): [string, number] {
  let out = "";
  let i = start;
  while (i < input.length) {
    const c = input[i]!;
    i++;
    if (c === "\\") {
      if (i >= input.length) break;
      out += input[i]!;
      i++;
      continue;
    }
    if (c === '"') return [out, i];
    out += c;
  }
  throw new Error("unterminated quoted-string");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
