/** Shared test helpers: an isolated XPAY_HOME and a routed fetch mock. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Discovery caches catalogs on disk under $XPAY_HOME; keep tests off ~/.xpay.
export const XPAY_HOME = mkdtempSync(join(tmpdir(), "xpay-test-"));
process.env.XPAY_HOME = XPAY_HOME;

/** Drop the on-disk catalog cache (pair with discover's invalidateCache()). */
export function clearDiskCache(): void {
  rmSync(join(XPAY_HOME, "cache"), { recursive: true, force: true });
}

export type Route = (url: URL) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Replace global fetch with `routes` (first match wins). Unmatched requests
 * fail loudly so a test can never reach the network. Returns the request log
 * and a restore function.
 */
export function mockFetch(routes: Route[]): { calls: URL[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    for (const route of routes) {
      const res = await route(url);
      if (res) return res;
    }
    throw new Error(`unmocked fetch: ${url.href}`);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}
