import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { BudgetBanner } from "./shell/BudgetBanner.js";
import { useAppData } from "./useAppData.js";
import { useProjects } from "./useProjects.js";
import { TasksPage } from "./tasks/TasksPage.js";
import { TaskDetailPage } from "./task/TaskDetailPage.js";
import { InboxPage } from "./inbox/InboxPage.js";
import { TokenGate } from "./components/TokenGate.js";
import { PlansPage } from "./plans/PlansPage.js";
import { PlanPage } from "./plans/PlanPage.js";
import { AddProjectGate } from "./components/Projects.js";
import { AppShell } from "./shell/AppShell.js";
import { correctedRoute, routeForProject, routePid, type Route } from "./lib/route.js";
import { useRoute } from "./lib/useRoute.js";
import { groupTasks } from "./lib/task-groups.js";
import { markRunning } from "./lib/first-seen.js";
import { OverviewPage } from "./overview/OverviewPage.js";
import { SettingsScreen } from "./settings/SettingsScreen.js";
import { NowStrip } from "./overview/NowStrip.js";

export function App() {
  const { route, navigate } = useRoute();
  // useProjects needs `settings` (from useAppData) and useAppData needs the selected id and the
  // projects reload (from useProjects). Break the cycle with a mirrored id and a stable reload.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const reloadProjects = useCallback(() => reloadRef.current(), []);
  const data = useAppData(selectedId, reloadProjects);
  const { settings, budget, refresh, needsToken, clearNeedsToken } = data;
  const { projects, selected, select, reload } = useProjects(settings, routePid(route));
  reloadRef.current = reload;
  // The route before this one, for "← Tasks"; switching tabs of one task keeps the origin.
  const current = useRef<Route | null>(route);
  const previous = useRef<Route | null>(null);
  if (current.current !== route) {
    const sameTask =
      current.current?.name === "task" &&
      route?.name === "task" &&
      current.current.pid === route.pid &&
      current.current.taskId === route.taskId;
    if (!sameTask) previous.current = current.current;
    current.current = route;
  }
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

  // A missing route, or one naming a project that does not exist, is replaced by the nearest valid
  // one once the projects have loaded; the replace keeps Back from returning to it.
  const projectIds = useMemo(() => projects?.map((p) => p.id) ?? null, [projects]);
  const routeUnknownProject =
    !!route && route.name !== "inbox" && !!projects && !projects.some((p) => p.id === route.pid);
  useEffect(() => {
    const fix = correctedRoute(route, projectIds, currentId);
    if (fix) navigate(fix, { replace: true });
  }, [route, projectIds, currentId, navigate]);

  /** Switch project: the equivalent screen there, pushed so Back returns to the old project. */
  const openProject = (id: string) => {
    select(id);
    navigate(routeForProject(route, id));
  };

  /** A project was added: reload the list first, so the URL is not corrected back to the old one. */
  const addProject = async (p: Project) => {
    await reload().catch(() => {});
    select(p.id);
    navigate({ name: "overview", pid: p.id });
    void refresh().catch(() => {});
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
      <AddProjectGate projectsRoot={settings.projectsRoot} onAdded={(p) => void addProject(p)} />
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
      onProjectAdded={(p) => void addProject(p)}
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
        <TaskDetailPage
          key={`${pid}/${route.taskId}`}
          pid={pid}
          taskId={route.taskId}
          view={route.view}
          data={data}
          navigate={navigate}
          previous={previous.current}
        />
      )}
      {routeReady && route.name === "plans" && (
        <>
          <NowStrip pid={pid} groups={groups} />
          {route.planId ? (
            <PlanPage
              key={`${pid}/${route.planId}`}
              pid={pid}
              planId={route.planId}
              goalId={route.goalId}
              data={data}
              navigate={navigate}
            />
          ) : (
            <PlansPage pid={pid} data={data} navigate={navigate} />
          )}
        </>
      )}
      {routeReady && route.name === "settings" && settings && selected && (
        <SettingsScreen
          key={selected.id}
          pid={selected.id}
          page={route.page}
          settings={settings}
          project={selected}
          projects={projects ?? []}
          data={data}
          onProjectAdded={(p) => void addProject(p)}
          reloadProjects={reload}
        />
      )}
      {route?.name === "inbox" && (
        <InboxPage
          selectedPid={selected?.id ?? null}
          data={data}
          projects={projects ?? []}
          navigate={navigate}
        />
      )}
    </AppShell>
  );
}
