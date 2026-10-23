import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TaskView } from "./api.js";
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
import { AddProjectGate, ProjectSwitcher } from "./components/Projects.js";

type Tab = "tasks" | "commands" | "actions" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [actions, setActions] = useState<TaskView[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { projects, selected, selectedId, select, reload: reloadProjects } = useProjects(settings);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const loadTasks = useCallback(async (pid: string | null) => {
    if (!pid) return setTasks([]);
    const t = await api.listTasks(pid);
    // Ignore a response for a project the user has already switched away from.
    if (selectedRef.current === pid) setTasks(t);
  }, []);

  /** Refresh everything; tasks only when the change concerns the selected project. */
  const refresh = useCallback(
    async (project?: string) => {
      const [s] = await Promise.all([
        api.getSettings(),
        reloadProjects(),
        api.actions().then(setActions),
      ]);
      setSettings(s);
      const pid = selectedRef.current;
      if (pid && (!project || project === pid)) await loadTasks(pid);
    },
    [reloadProjects, loadTasks],
  );

  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => onUnauthorized(() => setNeedsToken(true)), []);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  useLive(refresh);

  // Switching project: drop the old list and any open editor, then load the new one.
  useEffect(() => {
    setTasks([]);
    setEditingId(null);
    void loadTasks(selectedId).catch(() => {});
  }, [selectedId, loadTasks]);

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
              onEdit={setEditingId}
              onChange={refresh}
              onNew={() => setEditingId("__new__")}
            />
          </>
        )}
        {selectedId && tab === "tasks" && editingId && (
          <Editor
            projectId={selectedId}
            taskId={editingId}
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
