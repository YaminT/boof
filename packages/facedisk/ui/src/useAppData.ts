import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "@boof/heart/schema";
import { api, ApiError, type PlanSummary, type TaskView } from "./api.js";
import type { BudgetStatus } from "./api-types.js";
import { onUnauthorized, type UnauthorizedReason } from "./token.js";
import { useLive } from "./useLive.js";
import { latestGuard } from "./lib/latest.js";
import { emptyList, settleList, type ListState } from "./lib/list-load.js";

export interface AppData {
  settings: Settings | null;
  /** The key may not read settings (403): the Settings area still opens, with what it can reach. */
  settingsDenied: boolean;
  tasks: TaskView[];
  /** True once the selected project's task list has loaded (false right after a switch). */
  tasksLoaded: boolean;
  /** The task list request failed. Rows already on screen stay; an empty list shows a retry. */
  tasksError: boolean;
  actions: TaskView[];
  plans: PlanSummary[];
  /** The plan list request failed. */
  plansError: boolean;
  budget: BudgetStatus | null;
  /** Bumped on each `plan.*` event for the selected project; plan views reload on it. */
  planTick: number;
  refresh(project?: string): Promise<void>;
  needsToken: UnauthorizedReason | null;
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
  const [taskState, setTasks] = useState<ListState<TaskView>>(emptyList);
  const [actions, setActions] = useState<TaskView[]>([]);
  const [planState, setPlans] = useState<ListState<PlanSummary>>(emptyList);
  const tasks = useMemo(
    () => (taskState.pid === selectedId ? taskState.items : []),
    [taskState, selectedId],
  );
  const tasksLoaded = taskState.pid === selectedId && taskState.loaded;
  const tasksError = taskState.pid === selectedId && taskState.error;
  const plans = useMemo(
    () => (planState.pid === selectedId ? planState.items : []),
    [planState, selectedId],
  );
  const plansError = planState.pid === selectedId && planState.error;
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [planTick, setPlanTick] = useState(0);
  const [needsToken, setNeedsToken] = useState<UnauthorizedReason | null>(null);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Overlapping loads can answer out of order: only the newest reply may land.
  const taskGuard = useRef(latestGuard());
  const planGuard = useRef(latestGuard());
  const actionGuard = useRef(latestGuard());

  const loadTasks = useCallback(async (pid: string | null) => {
    if (!pid) return setTasks(emptyList());
    const seq = taskGuard.current.begin();
    try {
      const t = await api.listTasks(pid);
      // Ignore a stale reply, and one for a project the user has already switched away from.
      if (taskGuard.current.accept(seq) && selectedRef.current === pid)
        setTasks((cur) => settleList(cur, pid, { ok: true, items: t }));
    } catch {
      if (taskGuard.current.accept(seq) && selectedRef.current === pid)
        setTasks((cur) => settleList(cur, pid, { ok: false }));
    }
  }, []);

  const loadPlans = useCallback(async (pid: string | null) => {
    if (!pid) return setPlans(emptyList());
    const seq = planGuard.current.begin();
    try {
      const p = await api.listPlans(pid);
      if (planGuard.current.accept(seq) && selectedRef.current === pid)
        setPlans((cur) => settleList(cur, pid, { ok: true, items: p }));
    } catch {
      if (planGuard.current.accept(seq) && selectedRef.current === pid)
        setPlans((cur) => settleList(cur, pid, { ok: false }));
    }
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

  useEffect(() => onUnauthorized((reason) => setNeedsToken(reason)), []);
  const clearNeedsToken = useCallback(() => setNeedsToken(null), []);

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
    setTasks({ pid: selectedId, items: [], loaded: false, error: false });
    setPlans({ pid: selectedId, items: [], loaded: false, error: false });
    void loadTasks(selectedId).catch(() => {});
    void loadPlans(selectedId).catch(() => {});
  }, [selectedId, loadTasks, loadPlans]);

  return {
    settings,
    settingsDenied,
    tasks,
    tasksLoaded,
    tasksError,
    actions,
    plans,
    plansError,
    budget,
    planTick,
    refresh,
    needsToken,
    clearNeedsToken,
  };
}
