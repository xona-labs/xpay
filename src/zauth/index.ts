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

export function isScanPending(data: unknown): data is ScanPending {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { status?: unknown }).status === "scanning" &&
    typeof (data as { sessionToken?: unknown }).sessionToken === "string"
  );
}

/** One unpaid GET against the scan-status endpoint. */
export async function fetchScanStatus(sessionToken: string): Promise<unknown> {
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
  while (isScanPending(last) && Date.now() < deadline) {
    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, wait));
    last = await fetchScanStatus(sessionToken);
  }
  return last;
}
