import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { HarnessStatus } from "./api-types.js";

export interface HarnessesState {
  /** The last answer; null while the first check is running or when it failed. */
  status: HarnessStatus | null;
  loading: boolean;
  failed: boolean;
  /** Check again (the server caches an answer for a few minutes; this asks for a fresh one). */
  refresh: () => void;
}

/** Which coding agents are installed on the computer that runs boof (needs settings:read). */
export function useHarnesses(projectId?: string): HarnessesState {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api
      .harnesses(attempt > 0, projectId)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [attempt, projectId]);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return { status, loading, failed, refresh };
}
