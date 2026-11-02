import { useEffect, useMemo, useState } from "react";
import { api, type EpicView, type TaskView } from "../api.js";

/**
 * The project's epics by id, for naming the epic chips. They reload when the project changes or
 * when the set of epics the tasks name changes. A failed load just leaves ids unresolved.
 */
export function useEpics(pid: string, tasks: TaskView[]): Map<string, EpicView> {
  const [loaded, setLoaded] = useState<{ pid: string; items: EpicView[] }>({ pid, items: [] });
  const signature = useMemo(
    () => [...new Set(tasks.flatMap((t) => (t.epicId ? [t.epicId] : [])))].sort().join(","),
    [tasks],
  );
  useEffect(() => {
    let live = true;
    api.listEpics(pid, true).then(
      (items) => live && setLoaded({ pid, items }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pid, signature]);
  return useMemo(
    () => new Map((loaded.pid === pid ? loaded.items : []).map((e) => [e.id, e])),
    [loaded, pid],
  );
}
