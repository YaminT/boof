import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "@boof-runner/shared/schema";
import { api, ApiError, type PlanSummary, type TaskView } from "./api.js";
import type { BudgetStatus } from "./api-types.js";
import { onUnauthorized } from "./token.js";
import { useLive } from "./useLive.js";
import { latestGuard } from "./lib/latest.js";

export interface AppData {
  settings: Settings | null;
  /** The key may not read settings (403): the Settings area still opens, with what it can reach. */
  settingsDenied: boolean;
  tasks: TaskView[];
  /** True once the selected project's task list has loaded (false right after a switch). */
  tasksLoaded: boolean;
  actions: TaskView[];
  plans: PlanSummary[];
  budget: BudgetStatus | null;
  /** Bumped on each `plan.*` event for the selected project; plan views reload on it. */
  planTick: number;
  refresh(project?: string): Promise<void>;
  needsToken: boolean;
  clearNeedsToken(): void;
}

/**
 * Loads and keeps fresh everything the app shows besides the project list: settings, the
 * selected project's tasks and plans, pending actions and the budget. Live events refresh only
 * what they name. Project state stays in `useProjects`; `refresh` reloads it via `reloadProjects`.
 */
export function useAppData(
  selectedId: string | null,
  reloadProjects: () => Promise<void>,
): AppData {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsDenied, setSettingsDenied] = useState(false);
  // Lists are tagged with the project they belong to, so a render right after a project switch
  // never shows the previous project's tasks or plans.
  const [taskState, setTasks] = useState<{
    pid: string | null;
    items: TaskView[];
    loaded: boolean;
  }>({ pid: null, items: [], loaded: false });
  const [actions, setActions] = useState<TaskView[]>([]);
  const [planState, setPlans] = useState<{ pid: string | null; items: PlanSummary[] }>({
    pid: null,
    items: [],
  });
  const tasks = useMemo(
    () => (taskState.pid === selectedId ? taskState.items : []),
    [taskState, selectedId],
  );
  const tasksLoaded = taskState.pid === selectedId && taskState.loaded;
  const plans = useMemo(
    () => (planState.pid === selectedId ? planState.items : []),
    [planState, selectedId],
  );
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [planTick, setPlanTick] = useState(0);
  const [needsToken, setNeedsToken] = useState(false);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Overlapping loads can answer out of order: only the newest reply may land.
  const taskGuard = useRef(latestGuard());
  const planGuard = useRef(latestGuard());
  const actionGuard = useRef(latestGuard());

  const loadTasks = useCallback(async (pid: string | null) => {
    if (!pid) return setTasks({ pid: null, items: [], loaded: false });
    const seq = taskGuard.current.begin();
    const t = await api.listTasks(pid);
    // Ignore a stale reply, and one for a project the user has already switched away from.
    if (taskGuard.current.accept(seq) && selectedRef.current === pid)
      setTasks({ pid, items: t, loaded: true });
  }, []);

  const loadPlans = useCallback(async (pid: string | null) => {
    if (!pid) return setPlans({ pid: null, items: [] });
    const seq = planGuard.current.begin();
    const p = await api.listPlans(pid);
    if (planGuard.current.accept(seq) && selectedRef.current === pid) setPlans({ pid, items: p });
  }, []);

  const refreshTasks = useCallback(
    async (project?: string) => {
      const pid = selectedRef.current;
      if (pid && (!project || project === pid)) await loadTasks(pid);
    },
    [loadTasks],
  );
  const refreshPlans = useCallback(
    async (project?: string) => {
      const pid = selectedRef.current;
      if (pid && (!project || project === pid)) await loadPlans(pid);
    },
    [loadPlans],
  );
  const refreshActions = useCallback(async () => {
    const seq = actionGuard.current.begin();
    const list = await api.actions();
    if (actionGuard.current.accept(seq)) setActions(list);
  }, []);
  const refreshSettings = useCallback(
    () =>
      api.getSettings().then(
        (s) => {
          setSettings(s);
          setSettingsDenied(false);
        },
        (err) => {
          if (err instanceof ApiError && err.status === 403) setSettingsDenied(true);
          else throw err;
        },
      ),
    [],
  );
  const refreshBudget = useCallback(
    () =>
      api
        .budget()
        .then(setBudget)
        .catch(() => {}),
    [],
  );

  /**
   * Refresh everything; tasks and plans only when the change concerns the selected project.
   * Never rejects: a failed load keeps the last data and the next live event retries.
   */
  const refresh = useCallback(
    async (project?: string) => {
      try {
        await Promise.all([
          refreshSettings(),
          refreshBudget(),
          reloadProjects(),
          refreshActions(),
          refreshTasks(project),
          refreshPlans(project),
        ]);
      } catch {
        // Keep showing what we have.
      }
    },
    [reloadProjects, refreshSettings, refreshBudget, refreshActions, refreshTasks, refreshPlans],
  );

  useEffect(() => onUnauthorized(() => setNeedsToken(true)), []);
  const clearNeedsToken = useCallback(() => setNeedsToken(false), []);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // Typed events refresh only what they name; `changed` hints (file changes that are not events)
  // refresh everything unless a typed event for the same project just did.
  const lastTyped = useRef(new Map<string, number>());
  useLive({
    onEvent: (e) => {
      const key = e.project ?? "";
      lastTyped.current.set(key, Date.now());
      if (e.type === "runner.enabled") void refreshSettings().catch(() => {});
      else if (e.type === "runner.budget_exceeded") void refreshBudget();
      else if (e.type.startsWith("task.")) {
        void Promise.all([refreshTasks(e.project), refreshActions(), refreshBudget()]).catch(
          () => {},
        );
      } else if (e.type.startsWith("plan.")) {
        if (!e.project || e.project === selectedRef.current) setPlanTick((n) => n + 1);
        void Promise.all([refreshTasks(e.project), refreshPlans(e.project)]).catch(() => {});
      }
    },
    onChanged: (project) => {
      if (Date.now() - (lastTyped.current.get(project ?? "") ?? 0) < 500) return;
      void refresh(project).catch(() => {});
    },
    onReconnect: () => void refresh().catch(() => {}),
  });

  // Switching project: drop the old lists, then load the new ones.
  useEffect(() => {
    setTasks({ pid: selectedId, items: [], loaded: false });
    setPlans({ pid: selectedId, items: [] });
    void loadTasks(selectedId).catch(() => {});
    void loadPlans(selectedId).catch(() => {});
  }, [selectedId, loadTasks, loadPlans]);

  return {
    settings,
    settingsDenied,
    tasks,
    tasksLoaded,
    actions,
    plans,
    budget,
    planTick,
    refresh,
    needsToken,
    clearNeedsToken,
  };
}
