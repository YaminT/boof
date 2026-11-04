import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, type Plan } from "../api.js";
import { act } from "../lib/act.js";
import { conflictOf } from "../lib/conflict.js";
import { latestGuard } from "../lib/latest.js";
import { planErrorLines } from "../lib/plan-view.js";

export const PLAN_CONFLICT_TOAST = "The plan changed elsewhere, so nothing was changed. Try again.";

/**
 * One plan, kept fresh: it reloads on `tick` (a plan.* event), later replies win, a 404 sets
 * `missing` and any other load failure sets `failed`. `mutate` runs a write against the loaded
 * version; a version conflict reloads and says so, other errors become a toast.
 */
export function usePlan(pid: string, planId: string, tick: number) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const guard = useRef(latestGuard());
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;

  const reload = useCallback(async () => {
    const seq = guard.current.begin();
    try {
      const p = await api.getPlan(pid, planId);
      if (!guard.current.accept(seq)) return;
      setPlan(p);
      setMissing(false);
      setFailed(false);
    } catch (e) {
      if (!guard.current.accept(seq)) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setFailed(true);
    }
  }, [pid, planId]);

  useEffect(() => {
    void reload();
  }, [reload, tick]);

  const mutate = useCallback(
    async (
      fn: (p: Plan) => Promise<Plan>,
      failure: string,
      success?: string,
      /** Handles an error first; return true to suppress the toast. */
      handle?: (e: unknown) => boolean,
    ): Promise<Plan | undefined> => {
      const current = planRef.current;
      if (!current) return undefined;
      const next = await act(() => fn(current), {
        failure,
        ...(success ? { success } : {}),
        onError: (e) => {
          if (handle?.(e)) return true;
          if (conflictOf(e) === "plan") {
            toast.error(PLAN_CONFLICT_TOAST);
            void reload();
            return true;
          }
          if (e instanceof ApiError && e.code === "invalid_plan") {
            toast.error(`${failure}: ${planErrorLines(e)[0]}`);
            return true;
          }
          return false;
        },
      });
      if (next) setPlan(next);
      return next;
    },
    [reload],
  );

  return { plan, missing, failed, reload, mutate };
}
