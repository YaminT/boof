// A tiny shared cache for idempotent GETs: identical in-flight requests share one promise, and a
// fresh answer is reused for a few seconds. Any write, and any live event, drops it.

interface Entry {
  at: number;
  promise: Promise<unknown>;
  settled: boolean;
}

const entries = new Map<string, Entry>();
/** Default time a settled answer stays fresh. */
export const CACHE_TTL_MS = 8_000;

/** Run `load` once per `key` while its answer is in flight or younger than `ttlMs`. */
export function cachedGet<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs = CACHE_TTL_MS,
): Promise<T> {
  const hit = entries.get(key);
  if (hit && (!hit.settled || Date.now() - hit.at < ttlMs)) return hit.promise as Promise<T>;
  const entry: Entry = { at: Date.now(), promise: undefined as never, settled: false };
  entry.promise = load().then(
    (value) => {
      entry.settled = true;
      entry.at = Date.now();
      return value;
    },
    (err) => {
      // Failures are never cached.
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, entry);
  return entry.promise as Promise<T>;
}

/** Forget cached answers: all of them, or those whose key starts with `prefix`. */
export function invalidateCache(prefix?: string): void {
  for (const key of [...entries.keys()]) if (!prefix || key.startsWith(prefix)) entries.delete(key);
}

/** Keys of data a live event may have changed. Whoami, harnesses and updates are not among them. */
const LIVE_KEYS = ["actions", "settings", "runner/status", "budget", "usage", "projects"];

/** Drop the cached answers a live event may have made stale. */
export function invalidateLiveData(): void {
  for (const key of LIVE_KEYS) invalidateCache(key);
}
