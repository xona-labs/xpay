/**
 * Module-level cache for catalog fetches.
 *
 * Discovery against PayAI's full 21k-item catalog takes ~50s on a cold fetch,
 * which is unusable in a UI search loop. We cache the result in memory with a
 * TTL so repeat lookups (and concurrent ones via the in-flight promise) hit
 * the cache instead.
 *
 * Trade-off: a single process holds one snapshot per source. For server
 * deployments (the platform's API route), this naturally warms after the
 * first request. For very long-running processes, the TTL ensures freshness.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Resource } from "../types.js";

type Loader = () => Promise<Resource[]>;

interface Entry {
  expiresAt: number;
  data?: Resource[];
  inflight?: Promise<Resource[]>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const store = new Map<string, Entry>();

/** Where on-disk cache lives. Honors $XPAY_HOME (mirrors profile storage). */
function diskCacheDir(): string {
  const root = process.env.XPAY_HOME ?? join(homedir(), ".xpay");
  return join(root, "cache");
}
function diskCachePath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return join(diskCacheDir(), `${safe}.json`);
}

interface DiskEntry {
  expiresAt: number;
  data: Resource[];
}

function readDisk(key: string, allowStale = false): Resource[] | null {
  try {
    const file = diskCachePath(key);
    if (!existsSync(file)) return null;
    const blob = JSON.parse(readFileSync(file, "utf8")) as DiskEntry;
    if (allowStale || blob.expiresAt > Date.now()) return blob.data;
    return null;
  } catch {
    return null;
  }
}

function writeDisk(key: string, data: Resource[]): void {
  try {
    const dir = diskCacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const blob: DiskEntry = { expiresAt: Date.now() + ttlMs, data };
    writeFileSync(diskCachePath(key), JSON.stringify(blob));
  } catch {
    // Best-effort - cache failures should never break the call.
  }
}

/** TTL is configurable at runtime; defaults to 10 min. */
let ttlMs = DEFAULT_TTL_MS;
export function setCacheTtl(ms: number): void {
  ttlMs = ms;
}

/**
 * Get cached resources for `key`, loading via `loader` if missing or expired.
 * Concurrent calls during a cold load share the same in-flight promise.
 */
export async function cached(key: string, loader: Loader): Promise<Resource[]> {
  const now = Date.now();
  const entry = store.get(key);

  if (entry?.data && entry.expiresAt > now) return entry.data;
  if (entry?.inflight) return entry.inflight;

  // Try disk before paying the network cost. CLI invocations hit this path
  // every time (each invocation is a fresh process with empty memory).
  const onDisk = readDisk(key);
  if (onDisk) {
    store.set(key, { data: onDisk, expiresAt: now + ttlMs });
    return onDisk;
  }

  const inflight = loader().then(
    (data) => {
      store.set(key, { data, expiresAt: Date.now() + ttlMs });
      writeDisk(key, data);
      return data;
    },
    (err) => {
      store.delete(key);
      // Stale-on-error: a snapshot past its TTL beats a hard failure when the
      // upstream is down. Memory first (expired entries keep their data), then
      // disk with staleness allowed. Not re-cached as fresh, so the next call
      // retries the loader.
      const staleMem = entry?.data;
      if (staleMem) return staleMem;
      const staleDisk = readDisk(key, true);
      if (staleDisk) return staleDisk;
      throw err;
    },
  );
  store.set(key, { expiresAt: 0, inflight });
  return inflight;
}

// ── Source-down cooldown markers ─────────────────────────────────────────
// A failing catalog upstream (timeouts, 504s) should not re-charge its full
// timeout on every discover() call - especially from the CLI, where each
// invocation is a fresh process. Markers persist to the same disk dir.

const downStore = new Map<string, number>();

function downMarkerPath(source: string): string {
  return join(diskCacheDir(), `down_${source.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`);
}

/** Record that `source` is failing; callers should skip it for `ms`. */
export function markSourceDown(source: string, ms: number): void {
  const until = Date.now() + ms;
  downStore.set(source, until);
  try {
    const dir = diskCacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(downMarkerPath(source), JSON.stringify({ until }));
  } catch {
    // Best-effort.
  }
}

/** Whether `source` is inside a failure cooldown window. */
export function isSourceDown(source: string): boolean {
  const mem = downStore.get(source);
  if (mem !== undefined) return mem > Date.now();
  try {
    const file = downMarkerPath(source);
    if (!existsSync(file)) return false;
    const { until } = JSON.parse(readFileSync(file, "utf8")) as { until: number };
    downStore.set(source, until);
    return until > Date.now();
  } catch {
    return false;
  }
}

/** Force-evict a cache entry (or all entries with no arg). */
export function invalidate(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
