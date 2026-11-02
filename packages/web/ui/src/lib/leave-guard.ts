import { parseRoute, type Route } from "./route";

/**
 * A screen with unsaved work can ask to be consulted before the app navigates away. The guard
 * gets the target route and a `proceed` to call once the user agreed; it returns true when it took
 * over (the navigation waits), false to let it go through.
 */
export type LeaveGuard = (to: Route | null, proceed: () => void) => boolean;

let guard: LeaveGuard | null = null;

export function setLeaveGuard(g: LeaveGuard | null): void {
  guard = g;
}

/** True when a guard blocked the move; `proceed` runs later, if the user agrees. */
export function blockedByGuard(to: Route | null, proceed: () => void): boolean {
  return guard ? guard(to, proceed) : false;
}

export const routeOfPath = (path: string): Route | null => parseRoute(path);

/** Moving between settings pages of one project keeps the drafts, so it needs no question. */
export function staysInSettings(to: Route | null, pid: string): boolean {
  return !!to && to.name === "settings" && to.pid === pid;
}
