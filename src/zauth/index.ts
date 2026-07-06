/**
 * zauth partner integration — repository security scans behind zauth's
 * x402-paywalled endpoint. The scan POST is paid (normal x402 flow); results
 * are polled from an unpaid status URL keyed by sessionToken. A repo that
 * zauth has scanned recently may return its cached report on the POST
 * directly, with no polling step.
 */

export const ZAUTH_BASE = process.env.XPAY_ZAUTH_ENDPOINT ?? "https://api.zauth.inc";

export interface ScanPending {
  status: "scanning";
  sessionToken: string;
  [key: string]: unknown;
}

/**
 * Kickoff response from the paid POST: `{ status, scanId, sessionToken }`.
 * Only this response carries the sessionToken (a ~1h JWT) — poll responses
 * echo just `{ status, scanId, progress }`, so callers must hold on to the
 * token themselves.
 */
export function isScanPending(data: unknown): data is ScanPending {
  return (
    isScanning(data) && typeof (data as { sessionToken?: unknown }).sessionToken === "string"
  );
}

/** Any payload (kickoff or poll) that says the scan hasn't finished. */
export function isScanning(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { status?: unknown }).status === "scanning"
  );
}

/** One unpaid GET against the scan-status endpoint. */
export async function fetchScanStatus(sessionToken: string): Promise<unknown> {
  // The kickoff response carries both a short scanId and a JWT sessionToken;
  // only the JWT works here. Catch the mixup before it becomes an opaque 401.
  if (!sessionToken.includes(".")) {
    throw new Error(
      `zauth: "${sessionToken}" looks like a scanId — pass the sessionToken (the long JWT from the scan kickoff) instead`,
    );
  }
  const res = await fetch(`${ZAUTH_BASE}/x402/reposcan/${encodeURIComponent(sessionToken)}`);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : text.slice(0, 200);
    throw new Error(`zauth scan status ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

/**
 * Completed reports embed every provenance match with full file contents —
 * tens of KB the caller rarely needs (analysisMarkdown already summarizes
 * them). Swap the array for a count; use the raw payload when full detail
 * matters (CLI --json).
 */
export function compactScanReport(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const { matches, ...rest } = data as Record<string, unknown>;
  if (!Array.isArray(matches)) return data;
  return { ...rest, matchCount: matches.length };
}

export interface PollOptions {
  /** Give up (and return the still-scanning payload) after this long. Default 90s. */
  timeoutMs?: number;
  /** Delay between status checks. Default 5s. */
  intervalMs?: number;
}

/**
 * Poll the unpaid status endpoint until the scan leaves "scanning" or the
 * timeout elapses. On timeout the last payload (still pending) is returned
 * rather than throwing — callers surface the sessionToken for a later check.
 */
export async function pollRepoScan(sessionToken: string, opts: PollOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  let last = await fetchScanStatus(sessionToken);
  while (isScanning(last) && Date.now() < deadline) {
    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, wait));
    last = await fetchScanStatus(sessionToken);
  }
  return last;
}
