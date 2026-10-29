import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { BudgetBanner } from "./components/Budget.js";
import { useAppData } from "./useAppData.js";
import { useProjects } from "./useProjects.js";
import { TasksPage } from "./tasks/TasksPage.js";
import { Editor } from "./components/Editor.js";
import { CommandsTab } from "./components/CommandsTab.js";
import { ActionsTab } from "./components/ActionsTab.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TokenGate } from "./components/TokenGate.js";
import { PlansTab } from "./components/PlansTab.js";
import { AddProjectGate } from "./components/Projects.js";
import { AppShell } from "./shell/AppShell.js";
import { routePid } from "./lib/route.js";
import { useRoute } from "./lib/useRoute.js";
import { groupTasks } from "./lib/task-groups.js";
import { markRunning } from "./lib/first-seen.js";
import { OverviewPage } from "./overview/OverviewPage.js";
import { SettingsNav } from "./shell/SettingsNav.js";
import { NowStrip } from "./overview/NowStrip.js";

export function App() {
  const { route, navigate } = useRoute();
  // useProjects needs `settings` (from useAppData) and useAppData needs the selected id and the
  // projects reload (from useProjects). Break the cycle with a mirrored id and a stable reload.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const reloadProjects = useCallback(() => reloadRef.current(), []);
  const data = useAppData(selectedId, reloadProjects);
  const { settings, tasks, actions, budget, planTick, refresh, needsToken, clearNeedsToken } = data;
  const { projects, selected, select, reload } = useProjects(settings, routePid(route));
  reloadRef.current = reload;
  const groups = useMemo(() => groupTasks(data.tasks, data.plans), [data.tasks, data.plans]);
  // Keep the first-seen clock in step with what runs (layout effect: before child effects read it).
  const runningKey = groups.running.map((t) => t.frontmatter.id).join("\n");
  const currentId = selected?.id ?? null;
  // Only a loaded list for the selected project counts: the empty list right after a switch must
  // not look like "nothing runs". Other projects' clocks are left alone.
  useLayoutEffect(() => {
    if (!currentId || !data.tasksLoaded) return;
    markRunning(currentId, runningKey ? runningKey.split("\n") : [], Date.now());
  }, [currentId, data.tasksLoaded, runningKey]);
  useEffect(() => setSelectedId(currentId), [currentId]);

  // A missing route, or one naming a project that does not exist, goes to the Overview of the
  // selected project once the projects have loaded.
  const routeUnknownProject =
    !!route && route.name !== "inbox" && !!projects && !projects.some((p) => p.id === route.pid);
  useEffect(() => {
    if (!currentId) return;
    if (!route || routeUnknownProject)
      navigate({ name: "overview", pid: currentId }, { replace: true });
  }, [route, routeUnknownProject, currentId, navigate]);

  const openProject = (p: Project | string) => {
    const id = typeof p === "string" ? p : p.id;
    select(id);
    navigate({ name: "overview", pid: id });
  };

  if (needsToken) {
    return (
      <TokenGate
        onSubmit={() => {
          clearNeedsToken();
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
          openProject(p);
          void refresh().catch(() => {});
        }}
      />
    );
  }

  // Screens follow the route's project; render them only once the data hook has caught up to it.
  const pid = route && route.name !== "inbox" ? route.pid : null;
  const routeReady = !!pid && pid === selectedId && !!route && !routeUnknownProject;

  return (
    <AppShell
      data={data}
      projects={projects}
      selected={selected}
      route={route}
      navigate={navigate}
      onSelectProject={openProject}
      onProjectAdded={(p) => {
        openProject(p);
        void refresh().catch(() => {});
      }}
    >
      {budget && <BudgetBanner budget={budget} />}
      {routeReady && route.name === "overview" && (
        <OverviewPage pid={pid} project={selected} data={data} navigate={navigate} />
      )}
      {routeReady && route.name === "tasks" && (
        <>
          <NowStrip pid={pid} groups={groups} />
          <TasksPage pid={pid} data={data} navigate={navigate} />
        </>
      )}
      {routeReady && route.name === "task" && (
        <Editor
          projectId={pid}
          key={`${pid}/${route.taskId}`}
          taskId={route.taskId}
          initialView={route.view === "changes" ? "changes" : "edit"}
          onViewChange={(view) =>
            navigate({ name: "task", pid, taskId: route.taskId, view }, { replace: true })
          }
          onClose={() => navigate({ name: "tasks", pid })}
          onChange={refresh}
        />
      )}
      {routeReady && route.name === "plans" && (
        <>
          <NowStrip pid={pid} groups={groups} />
          <PlansTab
            key={`${pid}/plans`}
            projectId={pid}
            tasks={tasks}
            tick={planTick}
            planId={route.planId ?? null}
            onSelectPlan={(id) => navigate({ name: "plans", pid, ...(id ? { planId: id } : {}) })}
            onOpenTask={(id) => navigate({ name: "task", pid, taskId: id, view: "edit" })}
            onReviewTask={(id) => navigate({ name: "task", pid, taskId: id, view: "changes" })}
            onChange={refresh}
          />
        </>
      )}
      {routeReady && route.name === "settings" && <SettingsNav pid={pid} active={route.page} />}
      {routeReady && route.name === "settings" && route.page === "automation" && (
        <CommandsTab onChange={refresh} />
      )}
      {routeReady &&
        route.name === "settings" &&
        route.page !== "automation" &&
        settings &&
        selected && (
          <SettingsPage
            key={selected.id}
            settings={settings}
            projects={projects ?? []}
            project={selected}
            onChange={refresh}
          />
        )}
      {route?.name === "inbox" && (
        <ActionsTab actions={actions} projects={projects ?? []} onChange={refresh} />
      )}
    </AppShell>
  );
}
