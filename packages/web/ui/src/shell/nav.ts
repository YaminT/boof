import type { Route } from "../lib/route.js";

export type NavKey = "overview" | "tasks" | "plans" | "settings" | "inbox";

/** Which nav item a route belongs to (a task editor sits under Tasks). */
export function navKey(route: Route | null): NavKey | null {
  if (!route) return null;
  return route.name === "task" ? "tasks" : route.name;
}

export interface NavCounts {
  tasks: number;
  plans: number;
  inbox: number;
}
