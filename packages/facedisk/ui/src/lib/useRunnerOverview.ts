import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { startPoller, type Poller } from "./poller.js";
import { useLive } from "../useLive.js";
import type { RunnerOverview } from "./topbar.js";

const STALE_MS = 30_000;

/** Events that change what the topbar shows: runs, task status, the runner switch, budgets. */
export function changesRunnerOverview(type: string): boolean {
  return type.startsWith("task.") || type.startsWith("runner.") || type.startsWith("project.");
}

/**
 * `runner.overview`, refreshed when a live event says it changed and otherwise polled every
 * 30 s (10 s while the event stream is down). Polling pauses while the tab is hidden. A 403 means
 * the key may not read it: `denied` is set and polling stops. After 30 s of failures `stale` is
 * set and the last value is kept.
 */
export function useRunnerOverview(): {
  overview: RunnerOverview | null;
  denied: boolean;
  stale: boolean;
  reload: () => Promise<void>;
} {
  const [overview, setOverview] = useState<RunnerOverview | null>(null);
  const [denied, setDenied] = useState(false);
  const [stale, setStale] = useState(false);
  const lastOk = useRef(Date.now());
  const alive = useRef(true);
  const stopped = useRef(false);
  const poller = useRef<Poller | null>(null);
  const liveUp = useRef(false);

  const reload = useCallback(async () => {
    if (stopped.current) return;
    try {
      const next = await api.runnerOverview();
      if (!alive.current) return;
      lastOk.current = Date.now();
      setOverview(next);
      setStale(false);
    } catch (err) {
      if (!alive.current) return;
      if ((err as { status?: number }).status === 403) {
        stopped.current = true;
        setDenied(true);
        poller.current?.stop();
        return;
      }
      if (Date.now() - lastOk.current > STALE_MS) setStale(true);
      throw err;
    }
  }, []);

  useLive({
    onEvent: (e) => {
      if (changesRunnerOverview(e.type)) poller.current?.kick();
    },
    onChanged: () => poller.current?.kick(),
    onReconnect: () => poller.current?.kick(),
    onStatus: (up) => {
      liveUp.current = up;
      poller.current?.replan();
    },
  });

  useEffect(() => {
    alive.current = true;
    const p = startPoller({ load: reload, live: () => liveUp.current });
    poller.current = p;
    return () => {
      alive.current = false;
      p.stop();
      poller.current = null;
    };
  }, [reload]);

  // Manual reload (after toggling the runner): bypass the poll schedule.
  const manual = useCallback(async () => {
    await reload().catch(() => {});
  }, [reload]);

  return { overview, denied, stale, reload: manual };
}
