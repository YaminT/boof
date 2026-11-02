export type SettingsPageId = "project" | "agents" | "budgets" | "keys" | "automation";
export type TaskView = "edit" | "changes" | "questions";
export type Route =
  | { name: "overview"; pid: string }
  | { name: "tasks"; pid: string }
  | { name: "task"; pid: string; taskId: string; view: TaskView }
  | { name: "plans"; pid: string; planId?: string; goalId?: string }
  | { name: "settings"; pid: string; page: SettingsPageId }
  | { name: "inbox" };

const SETTINGS_PAGES: readonly SettingsPageId[] = [
  "project",
  "agents",
  "budgets",
  "keys",
  "automation",
];

/** Parses an app-relative path such as "p/boof/tasks"; one leading "/" is ignored. */
export function parseRoute(path: string): Route | null {
  if (path.startsWith("#")) return null;
  let segs: string[];
  try {
    segs = path
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segs.length === 0) return null;
  if (segs[0] === "inbox") return { name: "inbox" };
  if (segs[0] !== "p" || !segs[1]) return null;
  const pid = segs[1];
  const [section, a, b] = segs.slice(2);
  switch (section) {
    case "tasks":
      if (!a) return { name: "tasks", pid };
      return {
        name: "task",
        pid,
        taskId: a,
        view: b === "changes" || b === "questions" ? b : "edit",
      };
    case "plans": {
      const route: Route = { name: "plans", pid };
      if (a) route.planId = a;
      if (a && b) route.goalId = b;
      return route;
    }
    case "settings": {
      const page = SETTINGS_PAGES.find((p) => p === a) ?? "project";
      return { name: "settings", pid, page };
    }
    default:
      return { name: "overview", pid };
  }
}

/** App-relative (never starts with "/" or "#"); resolved against the pinned document base. */
export function formatRoute(route: Route): string {
  if (route.name === "inbox") return "inbox";
  const e = encodeURIComponent;
  const base = `p/${e(route.pid)}`;
  switch (route.name) {
    case "overview":
      return base;
    case "tasks":
      return `${base}/tasks`;
    case "task": {
      const t = `${base}/tasks/${e(route.taskId)}`;
      return route.view === "edit" ? t : `${t}/${route.view}`;
    }
    case "plans": {
      let p = `${base}/plans`;
      if (route.planId) {
        p += `/${e(route.planId)}`;
        if (route.goalId) p += `/${e(route.goalId)}`;
      }
      return p;
    }
    case "settings":
      return route.page === "project" ? `${base}/settings` : `${base}/settings/${route.page}`;
  }
}

export function routePid(route: Route | null): string | null {
  return route && route.name !== "inbox" ? route.pid : null;
}

/** The equivalent screen in project `pid`; ids that belong to the old project are dropped. */
export function routeForProject(route: Route | null, pid: string): Route {
  switch (route?.name) {
    case "tasks":
    case "task":
      return { name: "tasks", pid };
    case "plans":
      return { name: "plans", pid };
    case "settings":
      return { name: "settings", pid, page: route.page };
    default:
      return { name: "overview", pid };
  }
}

/** The list a task or plan page belongs to; other routes are returned as they are. */
export function listRouteFor(route: Route): Route {
  if (route.name === "task") return { name: "tasks", pid: route.pid };
  if (route.name === "plans" && route.planId) return { name: "plans", pid: route.pid };
  return route;
}

/**
 * The route that should replace the current one, or null when it is valid or the facts are not
 * loaded yet: no route means the selected project's Overview; an unknown project falls back to the
 * list of the selected project.
 */
export function correctedRoute(
  route: Route | null,
  projectIds: readonly string[] | null,
  selectedId: string | null,
): Route | null {
  if (!projectIds || !selectedId) return null;
  if (!route) return { name: "overview", pid: selectedId };
  if (route.name === "inbox" || projectIds.includes(route.pid)) return null;
  return routeForProject(route, selectedId);
}
