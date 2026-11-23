import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { HarnessStatus } from "./api-types.js";
import { useConnection } from "./lib/useConnection.js";

export interface HarnessesState {
  /** The last answer; null while the first check is running or when it failed. */
  status: HarnessStatus | null;
  loading: boolean;
  failed: boolean;
  /** The key lacks settings:read: the answer cannot be read at all. */
  denied: boolean;
  /** Check again (the server caches an answer for a few minutes; this asks for a fresh one). */
  refresh: () => void;
}

/** Which coding agents are installed on the computer that runs boof (needs settings:read). */
export function useHarnesses(projectId?: string): HarnessesState {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setDenied(false);
    api
      .harnesses(attempt > 0, projectId)
      .then((s) => !cancelled && setStatus(s))
      .catch((err) => {
        if (cancelled) return;
        setFailed(true);
        setDenied(err instanceof ApiError && err.status === 403);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [attempt, projectId]);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  // The checks that failed while boof was unreachable run again when the connection returns.
  const { state } = useConnection();
  const wasDown = useRef(false);
  useEffect(() => {
    if (state !== "live") wasDown.current = true;
    else if (wasDown.current) {
      wasDown.current = false;
      if (failed && !denied) setAttempt((n) => n + 1);
    }
  }, [state, failed, denied]);
  return { status, loading, failed, denied, refresh };
}
