import type { DoctorCheck, DoctorFixPage, HarnessStatus } from "../api-types.js";
import type { Route, SettingsPageId } from "./route.js";

/**
 * What the readiness gate says:
 * - checking: the first answer is not in yet;
 * - open: at least one agent is ready;
 * - blocked: the check ran and no agent is ready;
 * - unknown: the check could not be read (the key lacks settings:read, or the server failed). The
 *   server still refuses to start work, so the app is not locked on a guess.
 */
export type Gate = "checking" | "open" | "blocked" | "unknown";

export function gateOf(input: {
  status: HarnessStatus | null;
  loading: boolean;
  failed: boolean;
}): Gate {
  if (input.status) return input.status.anyReady ? "open" : "blocked";
  if (input.failed) return "unknown";
  return input.loading ? "checking" : "unknown";
}

/** Routes that stay reachable while no agent is ready: the way to fix things. */
export function reachableWhileBlocked(route: Route | null): boolean {
  return route?.name === "doctor" || route?.name === "settings";
}

const FIX_PAGE: Record<DoctorFixPage, SettingsPageId> = {
  agents: "agents",
  gateway: "accounts",
  projects: "project",
  sandbox: "agents",
  general: "project",
};

/** The project id used in a Settings link before any project exists. */
export const NO_PROJECT = "setup";

/** The Settings screen where a check is fixed, or null when it has no Settings fix. */
export function fixRoute(page: DoctorFixPage | undefined, pid: string | null): Route | null {
  return page ? { name: "settings", pid: pid ?? NO_PROJECT, page: FIX_PAGE[page] } : null;
}

export interface DoctorSummary {
  passed: boolean;
  fails: number;
  warns: number;
}

export function summarize(checks: readonly DoctorCheck[]): DoctorSummary {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return { passed: fails === 0, fails, warns };
}

/** Where "Continue" goes: the page the app was opened on, else the selected project's Overview. */
export function continueRoute(
  entry: Route | null,
  selectedPid: string | null,
  knownPids: readonly string[] | null,
): Route | null {
  if (entry && entry.name !== "doctor") {
    if (entry.name === "inbox" || !knownPids || knownPids.includes(entry.pid)) return entry;
  }
  return selectedPid ? { name: "overview", pid: selectedPid } : null;
}
