import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TaskView } from "./api.js";
import type { BudgetStatus } from "./api-types.js";
import { BudgetBanner } from "./components/Budget.js";
import { boofRunnerLogoUrl } from "./assets.js";
import { useLive } from "./useLive.js";
import { useProjects } from "./useProjects.js";
import type { Settings } from "@boof-runner/shared/schema";
import { TaskList } from "./components/TaskList.js";
import { LivePanel } from "./components/LivePanel.js";
import { Editor } from "./components/Editor.js";
import { CommandsTab } from "./components/CommandsTab.js";
import { ActionsTab } from "./components/ActionsTab.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TokenGate } from "./components/TokenGate.js";
import { onUnauthorized } from "./token.js";
import { PlansTab } from "./components/PlansTab.js";
import { AddProjectGate, ProjectSwitcher } from "./components/Projects.js";

type Tab = "tasks" | "plans" | "commands" | "actions" | "settings";

const PLANS_HASH = /^#\/p\/[^/?#]+\/plans(?:\/([^/?#]+))?/;
function readPlansHash(): { open: boolean; planId: string | null } {
  const m = PLANS_HASH.exec(window.location.hash);
  return { open: !!m, planId: m?.[1] ? decodeURIComponent(m[1]) : null };
}

/** `#/p/<pid>/tasks/<taskId>[/changes]`: an open task editor, optionally on its Changes tab. */
const TASK_HASH = /^#\/p\/([^/?#]+)\/tasks\/([^/?#]+)(\/changes)?/;
function readTaskHash(): { pid: string; taskId: string; view: "edit" | "changes" } | null {
  const m = TASK_HASH.exec(window.location.hash);
  if (!m) return null;
  try {
    return {
      pid: decodeURIComponent(m[1]!),
      taskId: decodeURIComponent(m[2]!),
      view: m[3] ? "changes" : "edit",
    };
  } catch {
    return null;
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => (readPlansHash().open ? "plans" : "tasks"));
  // An editor linked from the URL hash is restored once the projects have loaded.
  const restoreTask = useRef(readTaskHash());
  const [planId, setPlanId] = useState<string | null>(() => readPlansHash().planId);
  const [planTick, setPlanTick] = useState(0);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [actions, setActions] = useState<TaskView[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editingId, setEditingId] = useState<string | null>(
    () => restoreTask.current?.taskId ?? null,
  );
  const [editorView, setEditorView] = useState<"edit" | "changes">(
    () => restoreTask.current?.view ?? "edit",
  );
  const { projects, selected, selectedId, select, reload: reloadProjects } = useProjects(settings);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const loadTasks = useCallback(async (pid: string | null) => {
    if (!pid) return setTasks([]);
    const t = await api.listTasks(pid);
    // Ignore a response for a project the user has already switched away from.
    if (selectedRef.current === pid) setTasks(t);
  }, []);

  const refreshTasks = useCallback(
    async (project?: string) => {
      const pid = selectedRef.current;
      if (pid && (!project || project === pid)) await loadTasks(pid);
    },
    [loadTasks],
  );
  const refreshActions = useCallback(() => api.actions().then(setActions), []);
  const refreshSettings = useCallback(() => api.getSettings().then(setSettings), []);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const refreshBudget = useCallback(
    () =>
      api
        .budget()
        .then(setBudget)
        .catch(() => {}),
    [],
  );

  /** Refresh everything; tasks only when the change concerns the selected project. */
  const refresh = useCallback(
    async (project?: string) => {
      await Promise.all([
        refreshSettings(),
        refreshBudget(),
        reloadProjects(),
        refreshActions(),
        refreshTasks(project),
      ]);
    },
    [reloadProjects, refreshSettings, refreshBudget, refreshActions, refreshTasks],
  );

  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => onUnauthorized(() => setNeedsToken(true)), []);

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
        void refreshTasks(e.project).catch(() => {});
      }
    },
    onChanged: (project) => {
      if (Date.now() - (lastTyped.current.get(project ?? "") ?? 0) < 500) return;
      void refresh(project).catch(() => {});
    },
    onReconnect: () => void refresh().catch(() => {}),
  });

  // Switching project: drop the old list and any open editor, then load the new one.
  useEffect(() => {
    const r = restoreTask.current;
    if (r) {
      if (!selectedId) return; // projects not loaded yet
      restoreTask.current = null;
      if (selectedId === r.pid) {
        void loadTasks(selectedId).catch(() => {});
        return;
      }
    }
    setTasks([]);
    setEditingId(null);
    void loadTasks(selectedId).catch(() => {});
  }, [selectedId, loadTasks]);

  const openEditor = (id: string, view: "edit" | "changes") => {
    setEditorView(view);
    setEditingId(id);
  };

  // Keep the URL hash in step with the tab: `#/p/<pid>/plans[/<planId>]` is linkable.
  useEffect(() => {
    if (!selectedId) return;
    const base = `#/p/${encodeURIComponent(selectedId)}`;
    const want =
      tab === "plans"
        ? `${base}/plans${planId ? `/${encodeURIComponent(planId)}` : ""}`
        : tab === "tasks" && editingId && editingId !== "__new__"
          ? `${base}/tasks/${encodeURIComponent(editingId)}${editorView === "changes" ? "/changes" : ""}`
          : base;
    if (restoreTask.current) return; // keep the linked hash until it has been restored
    if (window.location.hash !== want) window.history.replaceState(null, "", want);
  }, [tab, planId, selectedId, editingId, editorView]);

  const pendingActions = actions.length;

  // Short activity summary shown in the runner banner.
  const runningTask = tasks.find((t) => t.frontmatter.status === "running");
  const queued = tasks.filter(
    (t) => t.frontmatter.status === "pending" && !t.frontmatter.skip,
  ).length;
  const runnerReport = runningTask
    ? `Working on “${runningTask.frontmatter.title}”`
    : settings && !settings.runner.enabled
      ? queued
        ? `Paused · ${queued} queued`
        : "Paused"
      : queued
        ? `${queued} task${queued === 1 ? "" : "s"} queued`
        : "Idle · queue empty";

  if (needsToken) {
    return (
      <TokenGate
        onSubmit={() => {
          setNeedsToken(false);
          void refresh().catch(() => {});
        }}
      />
    );
  }

  // First-run gate: block the app until the first project is added.
  if (settings && projects && projects.length === 0) {
    return (
      <AddProjectGate
        onAdded={(p) => {
          select(p.id);
          void refresh().catch(() => {});
        }}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={boofRunnerLogoUrl} alt="Boof Runner" />
          <div className="brand-text">
            <span className="brand-name">Boof Runner</span>
            <span className="brand-sub">Agent Task Runner</span>
          </div>
        </div>
        <nav>
          <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
            Tasks
          </button>
          <button className={tab === "plans" ? "active" : ""} onClick={() => setTab("plans")}>
            Plans
          </button>
          <button className={tab === "commands" ? "active" : ""} onClick={() => setTab("commands")}>
            Commands
          </button>
          <button className={tab === "actions" ? "active" : ""} onClick={() => setTab("actions")}>
            Actions {pendingActions > 0 ? <span className="badge">{pendingActions}</span> : null}
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
      </aside>

      <main>
        {budget && <BudgetBanner budget={budget} />}
        {settings && projects && selected && (
          <ProjectSwitcher
            settings={settings}
            projects={projects}
            selected={selected}
            runnerReport={runnerReport}
            onSelect={select}
            onAdded={(p) => {
              select(p.id);
              void refresh().catch(() => {});
            }}
            onChange={() => void refresh()}
          />
        )}
        {selectedId && tab === "tasks" && !editingId && (
          <>
            {runningTask && (
              <LivePanel
                key={runningTask.frontmatter.id}
                projectId={selectedId}
                task={runningTask}
                onChange={refresh}
              />
            )}
            <TaskList
              projectId={selectedId}
              tasks={tasks}
              onEdit={(id) => openEditor(id, "edit")}
              onReview={(id) => openEditor(id, "changes")}
              onChange={refresh}
              onNew={() => openEditor("__new__", "edit")}
            />
          </>
        )}
        {selectedId && tab === "plans" && (
          <PlansTab
            key={selectedId}
            projectId={selectedId}
            tasks={tasks}
            tick={planTick}
            planId={planId}
            onSelectPlan={setPlanId}
            onOpenTask={(id) => {
              openEditor(id, "edit");
              setTab("tasks");
            }}
            onReviewTask={(id) => {
              openEditor(id, "changes");
              setTab("tasks");
            }}
            onChange={refresh}
          />
        )}
        {selectedId && tab === "tasks" && editingId && (
          <Editor
            projectId={selectedId}
            key={editingId}
            taskId={editingId}
            initialView={editorView}
            onViewChange={setEditorView}
            onClose={() => setEditingId(null)}
            onChange={refresh}
          />
        )}
        {tab === "commands" && <CommandsTab onChange={refresh} />}
        {tab === "actions" && (
          <ActionsTab actions={actions} projects={projects ?? []} onChange={refresh} />
        )}
        {tab === "settings" && settings && selected && (
          <SettingsPage
            key={selected.id}
            settings={settings}
            projects={projects ?? []}
            project={selected}
            onChange={refresh}
          />
        )}
      </main>
    </div>
  );
}
