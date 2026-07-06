/**
 * Runtime adapter: hides the few places where Bun and Node.js diverge so the
 * rest of the codebase can stay portable (design D10). Everything here is
 * implemented with `node:` builtins, which run unchanged under both Bun and
 * Node >= 20; the adapter exists so that if a Bun-only fast path is ever added
 * it lives behind this single seam rather than leaking into call sites.
 */

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const runtimeName = isBun ? "bun" : "node";

/** Current wall-clock time as an ISO-8601 string. Centralized for testability. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** High-resolution monotonic milliseconds, for measuring step durations. */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
