import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { boofClawLogoUrl } from "./assets.js";
import { useLive } from "./useLive.js";
import type { Settings, Task } from "./types.js";
import { TaskList } from "./components/TaskList.js";
import { LivePanel } from "./components/LivePanel.js";
import { Editor } from "./components/Editor.js";
import { CommandsTab } from "./components/CommandsTab.js";
import { ActionsTab } from "./components/ActionsTab.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { WorkingDirGate, WorkingDirHeader } from "./components/WorkingDir.js";

type Tab = "tasks" | "commands" | "actions" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [t, s] = await Promise.all([api.listTasks(), api.getSettings()]);
    setTasks(t);
    setSettings(s);
  }, []);

  useEffect(() => {
    void refresh();
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

  // First-run gate: block the app until a working directory is chosen. It then
  // persists to settings.json, so the user is never asked again.
  if (settings && !settings.workingDirectory.trim()) {
    return <WorkingDirGate onChange={refresh} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={boofClawLogoUrl} alt="Boof Claw" />
          <div className="brand-text">
            <span className="brand-name">Boof Claw</span>
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
          <WorkingDirHeader settings={settings} runnerReport={runnerReport} onChange={refresh} />
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
        {tab === "settings" && settings && <SettingsPage settings={settings} onChange={refresh} />}
      </main>
    </div>
  );
}
