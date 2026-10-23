import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { boofRunnerLogoUrl } from "./assets.js";
import { useLive } from "./useLive.js";
import type { Project, Settings } from "@boof-runner/shared/schema";
import type { Task } from "@boof-runner/shared/task-types";
import { TaskList } from "./components/TaskList.js";
import { LivePanel } from "./components/LivePanel.js";
import { Editor } from "./components/Editor.js";
import { CommandsTab } from "./components/CommandsTab.js";
import { ActionsTab } from "./components/ActionsTab.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TokenGate } from "./components/TokenGate.js";
import { onUnauthorized } from "./token.js";
import { WorkingDirGate, WorkingDirHeader } from "./components/WorkingDir.js";

type Tab = "tasks" | "commands" | "actions" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.getSettings();
    // Minimal project support: act on the default project through the legacy task routes.
    const p = s.defaultProject ? await api.getProject(s.defaultProject).catch(() => null) : null;
    const t = p ? await api.listTasks() : [];
    setTasks(t);
    setProject(p);
    setSettings(s);
  }, []);

  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => onUnauthorized(() => setNeedsToken(true)), []);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  useLive(refresh);

  const pendingActions = tasks.filter((t) => t.frontmatter.questions === "pending").length;

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

  // First-run gate: block the app until a working directory is chosen. It then
  // persists to settings.json, so the user is never asked again.
  if (settings && !project?.workingDirectory.trim()) {
    return <WorkingDirGate onChange={refresh} />;
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
        {settings && (
          <WorkingDirHeader
            settings={settings}
            workingDir={project?.workingDirectory ?? ""}
            runnerReport={runnerReport}
            onChange={refresh}
          />
        )}
        {tab === "tasks" && !editingId && (
          <>
            {runningTask && (
              <LivePanel key={runningTask.frontmatter.id} task={runningTask} onChange={refresh} />
            )}
            <TaskList
              tasks={tasks}
              onEdit={setEditingId}
              onChange={refresh}
              onNew={() => setEditingId("__new__")}
            />
          </>
        )}
        {tab === "tasks" && editingId && (
          <Editor taskId={editingId} onClose={() => setEditingId(null)} onChange={refresh} />
        )}
        {tab === "commands" && <CommandsTab onChange={refresh} />}
        {tab === "actions" && <ActionsTab tasks={tasks} onChange={refresh} />}
        {tab === "settings" && settings && (
          <SettingsPage
            settings={settings}
            workingDir={project?.workingDirectory ?? ""}
            onChange={refresh}
          />
        )}
      </main>
    </div>
  );
}
