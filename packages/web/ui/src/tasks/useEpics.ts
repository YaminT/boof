import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type EpicView, type TaskView } from "../api.js";

export interface Epics {
  byId: Map<string, EpicView>;
  /** Every epic of the project, archived ones too, as the API orders them. */
  list: EpicView[];
  /** Load again, e.g. after the Manage epics sheet changed something. */
  reload: () => Promise<void>;
}

/**
 * The project's epics, for naming epic chips and for the epic menus. They reload when the project
 * changes or when the set of epics the tasks name changes. A failed load leaves ids unresolved.
 */
export function useEpics(pid: string | null, tasks: TaskView[]): Epics {
  const [loaded, setLoaded] = useState<{ pid: string | null; items: EpicView[] }>({
    pid,
    items: [],
  });
  const signature = useMemo(
    () => [...new Set(tasks.flatMap((t) => (t.epicId ? [t.epicId] : [])))].sort().join(","),
    [tasks],
  );
  const reload = useCallback(
    () =>
      pid === null
        ? Promise.resolve()
        : api.listEpics(pid, true).then(
            (items) => setLoaded({ pid, items }),
            () => undefined,
          ),
    [pid],
  );
  useEffect(() => {
    if (pid === null) return;
    let live = true;
    api.listEpics(pid, true).then(
      (items) => live && setLoaded({ pid, items }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pid, signature]);
  const list = loaded.pid === pid ? loaded.items : [];
  return useMemo(
    () => ({ byId: new Map(list.map((e) => [e.id, e])), list, reload }),
    [list, reload],
  );
}
