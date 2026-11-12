import { useEffect, useMemo, useState } from "react";
import { api, type Plan } from "../api.js";

/**
 * The full plans (their goals) for the given ids, loaded once each and again on `tick` (a plan.*
 * event). A plan that fails to load is left out: callers fall back to ids.
 */
export function usePlanDetails(
  pid: string,
  ids: string[],
  tick: number,
): ReadonlyMap<string, Plan> {
  const [loaded, setLoaded] = useState<{ pid: string; plans: Map<string, Plan> }>({
    pid,
    plans: new Map(),
  });
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    let live = true;
    const wanted = key ? key.split(",") : [];
    void Promise.all(wanted.map((id) => api.getPlan(pid, id).catch(() => null))).then((all) => {
      if (!live) return;
      const plans = new Map<string, Plan>();
      for (const p of all) if (p) plans.set(p.id, p);
      setLoaded({ pid, plans });
    });
    return () => {
      live = false;
    };
  }, [pid, key, tick]);
  return useMemo(() => (loaded.pid === pid ? loaded.plans : new Map()), [loaded, pid]);
}
