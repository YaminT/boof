import type { Route } from "../lib/route.js";

export type NavKey = "overview" | "tasks" | "plans" | "settings" | "inbox";

/** Which nav item a route belongs to (a task editor sits under Tasks). */
export function navKey(route: Route | null): NavKey | null {
  if (!route || route.name === "doctor") return null;
  if (route.name === "task") return "tasks";
  return route.name === "wizard" ? "plans" : route.name;
}

export interface NavCounts {
  tasks: number;
  plans: number;
  inbox: number;
}
