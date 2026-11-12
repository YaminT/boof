import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { RunnerOverview } from "./topbar.js";

const POLL_MS = 5000;
const STALE_MS = 30_000;

/**
 * `runner.overview`, polled every 5 s. A 403 means the key may not read it: `denied` is set and
 * polling stops. After 30 s of failures `stale` is set and the last value is kept.
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
        return;
      }
      if (Date.now() - lastOk.current > STALE_MS) setStale(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [reload]);

  return { overview, denied, stale, reload };
}
