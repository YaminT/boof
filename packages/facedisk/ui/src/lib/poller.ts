import { isHidden, onBecameVisible } from "./visibility.js";

export interface PollerOptions {
  /** One refresh. Throw to report a failure. */
  load: () => Promise<void>;
  /** True while the live event stream is up: polling is then only a slow safety net. */
  live: () => boolean;
  /** Poll interval while the stream is up (default 30 s). */
  liveMs?: number;
  /** Poll interval while the stream is down (default 10 s). */
  fallbackMs?: number;
  /** First retry delay after a failure; it doubles up to `maxBackoffMs` (default 5 s, 60 s). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Least time between two loads started by `kick` (default 1 s). */
  minGapMs?: number;
}

export interface Poller {
  /** Refresh soon, because an event says something changed. Coalesced; skipped while hidden. */
  kick(): void;
  /** The stream went up or down: re-plan the next poll. */
  replan(): void;
  stop(): void;
  /** Consecutive failures so far. */
  failures(): number;
}

/**
 * Loads once at start, then polls slowly. Polling pauses while the tab is hidden and one refresh
 * runs when it is visible again. Failures back off exponentially.
 */
export function startPoller(o: PollerOptions): Poller {
  const liveMs = o.liveMs ?? 30_000;
  const fallbackMs = o.fallbackMs ?? 10_000;
  const backoff = o.backoffMs ?? 5_000;
  const maxBackoff = o.maxBackoffMs ?? 60_000;
  const minGap = o.minGapMs ?? 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let fails = 0;
  let lastStart = 0;
  let dirty = false;

  const delay = () =>
    fails > 0 ? Math.min(maxBackoff, backoff * 2 ** (fails - 1)) : o.live() ? liveMs : fallbackMs;

  const plan = (ms = delay()) => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(tick, ms);
  };

  async function tick(): Promise<void> {
    if (stopped) return;
    // Hidden: do not fetch, do not re-arm. Becoming visible refreshes.
    if (isHidden()) {
      dirty = true;
      return;
    }
    if (running) return;
    running = true;
    dirty = false;
    lastStart = Date.now();
    try {
      await o.load();
      fails = 0;
    } catch {
      fails += 1;
    } finally {
      running = false;
    }
    plan();
  }

  const offVisible = onBecameVisible(() => {
    if (dirty || Date.now() - lastStart > 5_000) void tick();
  });
  void tick();

  return {
    kick() {
      if (stopped) return;
      if (isHidden()) {
        dirty = true;
        return;
      }
      const wait = Math.max(0, lastStart + minGap - Date.now());
      plan(wait);
    },
    replan() {
      if (!stopped && !running && !isHidden()) plan();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      offVisible();
    },
    failures: () => fails,
  };
}
