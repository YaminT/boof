import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Project } from "@boof/heart/schema";
import { BudgetBanner } from "./shell/BudgetBanner.js";
import { SandboxNoticeHost } from "./shell/SandboxNotice.js";
import { UpdateNotice } from "./shell/UpdateNotice.js";
import { useAppData } from "./useAppData.js";
import { useProjects } from "./useProjects.js";
import { TasksPage } from "./tasks/TasksPage.js";
import { SignInStorageError, TokenGate } from "./components/TokenGate.js";
import { getSignInStorageError, onSignInStorageError } from "./token.js";
import { AddProjectGate } from "./components/Projects.js";
import { AppShell } from "./shell/AppShell.js";
import { useHarnesses } from "./useHarnesses.js";
import { DoctorPage } from "./doctor/DoctorPage.js";
import {
  continueRoute,
  forgetEntry,
  gateOf,
  reachableWhileBlocked,
  recallEntry,
  rememberEntry,
} from "./lib/doctor.js";
import { isDesktop } from "./desktop.js";
import {
  correctedRoute,
  nextPrevious,
  routeForProject,
  routeKey,
  routePid,
  type Route,
} from "./lib/route.js";
import { useRoute } from "./lib/useRoute.js";
import { epicFromSearch, manageEpicsFromSearch } from "./lib/task-links.js";
import { groupTasks } from "./lib/task-groups.js";
import { markRunning } from "./lib/first-seen.js";
import { isDismissed, shouldAutoOpen } from "./lib/wizard.js";

const TaskDetailPage = lazy(() =>
  import("./task/TaskDetailPage.js").then((m) => ({ default: m.TaskDetailPage })),
);
const InboxPage = lazy(() =>
  import("./inbox/InboxPage.js").then((m) => ({ default: m.InboxPage })),
);
const OverviewPage = lazy(() =>
  import("./overview/OverviewPage.js").then((m) => ({ default: m.OverviewPage })),
);
// Screens loaded on first use, so the first paint does not carry them.
const PlansPage = lazy(() =>
  import("./plans/PlansPage.js").then((m) => ({ default: m.PlansPage })),
);
const PlanWizard = lazy(() =>
  import("./plans/PlanWizard.js").then((m) => ({ default: m.PlanWizard })),
);
const PlanPage = lazy(() => import("./plans/PlanPage.js").then((m) => ({ default: m.PlanPage })));
const SettingsScreen = lazy(() =>
  import("./settings/SettingsScreen.js").then((m) => ({ default: m.SettingsScreen })),
);

export function App() {
  const { route, navigate } = useRoute();
  // The setup check (doctor) is the first page of every app start; the page the app was opened on
  // is where Continue goes. Readiness itself is never stored: it is asked for again.
  const harnesses = useHarnesses();
  const gate = gateOf(harnesses);
  // A reload while the doctor shows lands on /doctor: the remembered page is the entry then.
  const entry = useRef<Route | null>(
    route && route.name !== "doctor" ? route : recallEntry(window.sessionStorage),
  );
  const [doctorSeen, setDoctorSeen] = useState(false);
  const [passed, setPassed] = useState(false);
  // useProjects needs `settings` (from useAppData) and useAppData needs the selected id and the
  // projects reload (from useProjects). Break the cycle with a mirrored id and a stable reload.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const reloadProjects = useCallback(() => reloadRef.current(), []);
  const data = useAppData(selectedId, reloadProjects);
  const { settings, budget, refresh, needsToken, clearNeedsToken } = data;
  const storageError = useSyncExternalStore(
    onSignInStorageError,
    getSignInStorageError,
    getSignInStorageError,
  );
  const { projects, projectsDenied, selected, select, reload } = useProjects(
    settings,
    routePid(route),
  );
  reloadRef.current = reload;
  // The route before this one, for "← Tasks"; switching tabs of one task keeps the origin.
  const current = useRef<Route | null>(route);
  const previous = useRef<Route | null>(null);
  if (current.current !== route) {
    previous.current = nextPrevious(previous.current, current.current, route);
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
    !!route &&
    route.name !== "inbox" &&
    route.name !== "doctor" &&
    !!projects &&
    !projects.some((p) => p.id === route.pid);
  useEffect(() => {
    const fix = correctedRoute(route, projectIds, currentId);
    if (fix) navigate(fix, { replace: true });
  }, [route, projectIds, currentId, navigate]);

  // A project with no tasks and no plans opens the plan wizard, unless it was skipped for it.
  const planCount = data.plans.length;
  const taskCount = data.tasks.length;
  const plansLoaded = !data.plansError && data.plansLoaded;
  const emptyProject =
    gate !== "blocked" &&
    !!route &&
    (route.name === "overview" || route.name === "tasks" || route.name === "plans") &&
    !(route.name === "plans" && route.planId) &&
    route.pid === currentId &&
    shouldAutoOpen({
      loaded: data.tasksLoaded && plansLoaded,
      taskCount,
      planCount,
      dismissed: isDismissed(window.localStorage, route.pid),
    });
  useEffect(() => {
    if (emptyProject && route) navigate({ name: "wizard", pid: route.pid }, { replace: true });
  }, [emptyProject, route, navigate]);

  /** Switch project: the equivalent screen there, pushed so Back returns to the old project. */
  const openProject = (id: string) => {
    select(id);
    navigate(routeForProject(route, id));
  };

  /** A project was added: reload the list first, so the URL is not corrected back to the old one. */
  const addProject = async (p: Project) => {
    await reload().catch(() => {});
    select(p.id);
    navigate({ name: "wizard", pid: p.id });
    void refresh().catch(() => {});
  };

  // First page, and the lock: the doctor shows first on every start, and again whenever no agent
  // is ready (only Settings stays open, to fix things).
  const mustLand = !passed && !doctorSeen;
  const locked = gate === "blocked" && !reachableWhileBlocked(route);
  const showDoctor = route?.name === "doctor" || mustLand || locked;
  const routeName = route?.name ?? null;
  useEffect(() => {
    if (routeName === "doctor") setDoctorSeen(true);
  }, [routeName]);
  useEffect(() => {
    if (showDoctor && routeName !== "doctor") {
      // Locked mid-session: the page the user was on is where Continue returns to.
      if (route) entry.current = route;
      rememberEntry(window.sessionStorage, entry.current);
      navigate({ name: "doctor" }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDoctor, routeName, navigate]);
  // Coming back from Settings after a fix: ask again instead of trusting the last answer.
  const key = routeKey(route);
  const refreshHarnesses = harnesses.refresh;
  const wasKey = useRef(key);
  useEffect(() => {
    if (wasKey.current !== key && gate === "blocked") refreshHarnesses();
    wasKey.current = key;
  }, [key, gate, refreshHarnesses]);
  const goOn = () => {
    setPassed(true);
    forgetEntry(window.sessionStorage);
    const to = continueRoute(entry.current, selected?.id ?? null, projectIds);
    navigate(to ?? { name: "inbox" }, { replace: true });
  };

  // Sign-in cannot work while the server refuses to store sessions: show why instead of the gate.
  if (storageError) return <SignInStorageError message={storageError} />;

  if (needsToken) {
    return (
      <TokenGate
        reason={needsToken}
        onSubmit={() => {
          clearNeedsToken();
          void refresh().catch(() => {});
        }}
      />
    );
  }

  if (showDoctor) {
    return (
      <DoctorPage
        harnesses={harnesses}
        pid={selected?.id ?? null}
        isDesktop={isDesktop}
        onContinue={goOn}
      />
    );
  }

  // First-run gate: block the app until the first project is added (Settings stays reachable).
  if (settings && projects && projects.length === 0 && route?.name !== "settings") {
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
      harnesses={harnesses}
    >
      <Suspense fallback={null}>
        {budget && <BudgetBanner budget={budget} />}
        <SandboxNoticeHost onChanged={() => void refresh()} />
        <UpdateNotice />
        {routeReady && route.name === "overview" && (
          <OverviewPage pid={pid} project={selected} data={data} navigate={navigate} />
        )}
        {routeReady && route.name === "tasks" && (
          <>
            <TasksPage
              pid={pid}
              data={data}
              navigate={navigate}
              epic={epicFromSearch(window.location.search)}
              manageEpics={manageEpicsFromSearch(window.location.search)}
            />
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
            project={selected}
          />
        )}
        {routeReady && route.name === "wizard" && (
          <PlanWizard key={pid} pid={pid} data={data} navigate={navigate} />
        )}
        {routeReady && route.name === "plans" && (
          <>
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
        {routeReady &&
          route.name === "settings" &&
          (settings || data.settingsDenied) &&
          selected && (
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
        {route?.name === "settings" && (projectsDenied || projects?.length === 0) && !selected && (
          <SettingsScreen
            key={route.pid}
            pid={route.pid}
            page={route.page}
            settings={settings}
            project={null}
            projects={[]}
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
      </Suspense>
    </AppShell>
  );
}
