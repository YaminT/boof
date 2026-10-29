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

export function parseRoute(hash: string): Route | null {
  const path = hash.replace(/^#/, "");
  if (!path.startsWith("/")) return null;
  let segs: string[];
  try {
    segs = path
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
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

export function formatRoute(route: Route): string {
  if (route.name === "inbox") return "#/inbox";
  const e = encodeURIComponent;
  const base = `#/p/${e(route.pid)}`;
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
