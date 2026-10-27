import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "@boof-runner/shared/schema";
import { api, type PlanSummary, type TaskView } from "./api.js";
import type { BudgetStatus } from "./api-types.js";
import { onUnauthorized } from "./token.js";
import { useLive } from "./useLive.js";

export interface AppData {
  settings: Settings | null;
  tasks: TaskView[];
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
  // Lists are tagged with the project they belong to, so a render right after a project switch
  // never shows the previous project's tasks or plans.
  const [taskState, setTasks] = useState<{ pid: string | null; items: TaskView[] }>({
    pid: null,
    items: [],
  });
  const [actions, setActions] = useState<TaskView[]>([]);
  const [planState, setPlans] = useState<{ pid: string | null; items: PlanSummary[] }>({
    pid: null,
    items: [],
  });
  const tasks = useMemo(
    () => (taskState.pid === selectedId ? taskState.items : []),
    [taskState, selectedId],
  );
  const plans = useMemo(
    () => (planState.pid === selectedId ? planState.items : []),
    [planState, selectedId],
  );
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [planTick, setPlanTick] = useState(0);
  const [needsToken, setNeedsToken] = useState(false);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const loadTasks = useCallback(async (pid: string | null) => {
    if (!pid) return setTasks({ pid: null, items: [] });
    const t = await api.listTasks(pid);
    // Ignore a response for a project the user has already switched away from.
    if (selectedRef.current === pid) setTasks({ pid, items: t });
  }, []);

  const loadPlans = useCallback(async (pid: string | null) => {
    if (!pid) return setPlans({ pid: null, items: [] });
    const p = await api.listPlans(pid);
    if (selectedRef.current === pid) setPlans({ pid, items: p });
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
  const refreshActions = useCallback(() => api.actions().then(setActions), []);
  const refreshSettings = useCallback(() => api.getSettings().then(setSettings), []);
  const refreshBudget = useCallback(
    () =>
      api
        .budget()
        .then(setBudget)
        .catch(() => {}),
    [],
  );

  /** Refresh everything; tasks and plans only when the change concerns the selected project. */
  const refresh = useCallback(
    async (project?: string) => {
      await Promise.all([
        refreshSettings(),
        refreshBudget(),
        reloadProjects(),
        refreshActions(),
        refreshTasks(project),
        refreshPlans(project),
      ]);
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
    setTasks({ pid: selectedId, items: [] });
    setPlans({ pid: selectedId, items: [] });
    void loadTasks(selectedId).catch(() => {});
    void loadPlans(selectedId).catch(() => {});
  }, [selectedId, loadTasks, loadPlans]);

  return {
    settings,
    tasks,
    actions,
    plans,
    budget,
    planTick,
    refresh,
    needsToken,
    clearNeedsToken,
  };
}
