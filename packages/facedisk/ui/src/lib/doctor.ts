import type { DoctorCheck, DoctorFixPage, HarnessStatus } from "../api-types.js";
import { formatRoute, hasPid, parseRoute, type Route, type SettingsPageId } from "./route.js";

/**
 * What the readiness gate says:
 * - checking: the first answer is not in yet;
 * - open: at least one agent is ready;
 * - blocked: the check ran and no agent is ready;
 * - unknown: the check could not be read (the key lacks settings:read, or the server failed). The
 *   server still refuses to start work, so the app is not locked on a guess.
 */
export type Gate = "checking" | "open" | "blocked" | "unknown";

/**
 * Why boof cannot work, or null: no agent is ready, or the server reports git or the data folder
 * as a hard failure. Warnings never block.
 */
export function blockReason(status: HarnessStatus): string | null {
  if (!status.anyReady) return "Cannot run tasks yet: no coding agent is ready";
  const hard = status.checks.find(
    (c) => c.status === "fail" && (c.id === "git" || c.id === "dataRoot"),
  );
  return hard ? `Cannot run tasks yet: ${hard.label} is not usable` : null;
}

export function gateOf(input: {
  status: HarnessStatus | null;
  loading: boolean;
  failed: boolean;
}): Gate {
  if (input.status) return blockReason(input.status) ? "blocked" : "open";
  if (input.failed) return "unknown";
  return input.loading ? "checking" : "unknown";
}

/** Routes that stay reachable while no agent is ready: the way to fix things. */
export function reachableWhileBlocked(route: Route | null): boolean {
  return route?.name === "doctor" || route?.name === "settings";
}

/** One piece of a hint: plain text, or text that links to the Settings page it names. */
export interface HintPart {
  text: string;
  route?: Route;
}

/**
 * Splits a hint so each mention of Settings, an Anthropic API key or "Install <tool>" becomes a link
 * to the exact page: the fix page for "Settings", the project page for the API key, Agents for an
 * install.
 */
export function hintParts(
  hint: string,
  page: DoctorFixPage | undefined,
  pid: string | null,
): HintPart[] {
  const p = pid ?? NO_PROJECT;
  const settingsRoute = fixRoute(page, pid);
  const parts: HintPart[] = [];
  const re = /\bSettings\b|\b(?:an )?Anthropic API key\b|\bInstall [\w.-]+(?=\.|$)/g;
  let last = 0;
  for (const m of hint.matchAll(re)) {
    const text = m[0];
    const route: Route | null =
      text === "Settings"
        ? settingsRoute
        : text.startsWith("Install")
          ? { name: "settings", pid: p, page: "agents" }
          : { name: "settings", pid: p, page: "project" };
    if (!route) continue;
    if (m.index > last) parts.push({ text: hint.slice(last, m.index) });
    parts.push({ text, route });
    last = m.index + text.length;
  }
  if (last < hint.length) parts.push({ text: hint.slice(last) });
  return parts;
}

/** A warning that needs no action: the gateway is optional while an agent works without it. */
export function isOptionalMissing(status: HarnessStatus, c: DoctorCheck): boolean {
  return (
    c.status === "warn" &&
    c.id === "gateway" &&
    status.anyReady &&
    (c.message === "Not configured." ||
      c.message === "No account pool; agents use their own sign-in.")
  );
}

export function needsAttention(status: HarnessStatus): boolean {
  return status.checks.some(
    (c) => c.status === "fail" || (c.status === "warn" && !isOptionalMissing(status, c)),
  );
}

export type ChipTone = "ok" | "optional" | "warn" | "fail";

export interface DoctorChip {
  key: string;
  label: string;
  tone: ChipTone;
  /** The reason, shown as a tooltip. */
  reason: string;
  route: Route | null;
}

export interface DoctorView {
  tone: "ok" | "warn" | "fail";
  headline: string;
  summary: string;
  chips: DoctorChip[];
  /** Where the main call to action goes while something needs attention. */
  fix: Route | null;
}

const CHIP_LABEL: Record<DoctorCheck["id"], string> = {
  agents: "Agents",
  gateway: "Gateway",
  projectsRoot: "Projects folder",
  git: "Git",
  dataRoot: "Data folder",
  sandbox: "Sandbox",
};

/** What the Doctor card shows: tone, headline, quiet summary and one chip per thing checked. */
export function doctorView(status: HarnessStatus, pid: string | null): DoctorView {
  const chips: DoctorChip[] = [];
  const installed = Object.entries(status.tools).filter(([, t]) => t.installed);
  for (const [id, t] of installed) {
    chips.push({
      key: `tool-${id}`,
      label: t.displayName,
      tone: t.ready ? "ok" : "warn",
      reason: t.ready ? "Ready" : t.readyReason || t.message || "Not ready",
      route: t.ready ? null : fixRoute("agents", pid),
    });
  }
  const agents = status.checks.find((c) => c.id === "agents");
  if (!installed.length || (!status.anyReady && agents)) {
    chips.push({
      key: "agents",
      label: "No agent ready",
      tone: "fail",
      reason: agents?.message ?? "No coding agent is installed.",
      route: fixRoute("agents", pid),
    });
  }
  for (const c of status.checks) {
    if (c.id === "agents") continue;
    const optional = isOptionalMissing(status, c);
    chips.push({
      key: c.id,
      label: optional ? `${CHIP_LABEL[c.id]}: not set up (optional)` : CHIP_LABEL[c.id],
      tone: c.status === "pass" ? "ok" : optional ? "optional" : c.status,
      reason: c.message,
      route: c.status === "pass" || optional ? null : fixRoute(c.fixPage, pid),
    });
  }
  const blocked = blockReason(status) !== null;
  const attention = needsAttention(status);
  const problem = status.checks.find((c) => c.status !== "pass" && !isOptionalMissing(status, c));
  const ready = Object.values(status.tools).filter((t) => t.ready).length;
  const passed = status.checks.filter((c) => c.status === "pass").length;
  const tone = blocked ? "fail" : attention ? "warn" : "ok";
  return {
    tone,
    headline: blocked
      ? "Boof can't run tasks yet"
      : attention
        ? `Needs attention: ${problem?.label ?? "a check"}`
        : "Everything is ready",
    summary: `${ready} agent${ready === 1 ? "" : "s"} ready · ${passed} of ${status.checks.length} checks passed`,
    chips,
    fix: problem ? fixRoute(problem.fixPage, pid) : null,
  };
}

/** The one-line summary of a passing setup. */
export function compactSummary(status: HarnessStatus): string {
  const n = Object.values(status.tools).filter((t) => t.ready).length;
  const gw = status.checks.find((c) => c.id === "gateway");
  const gateway = !gw || gw.status === "pass" ? "gateway OK" : "gateway not configured (optional)";
  return `Doctor: OK · ${n} agent${n === 1 ? "" : "s"} ready · ${gateway}`;
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

/** Where "Back to boof" goes: the page the app was opened on, else Home. */
export function continueRoute(
  entry: Route | null,
  _selectedPid: string | null,
  knownPids: readonly string[] | null,
): Route | null {
  if (entry && entry.name !== "doctor") {
    if (!hasPid(entry) || !knownPids || knownPids.includes(entry.pid)) return entry;
  }
  return { name: "home" };
}

/** What a successful in-app sign-in does: every request that failed for lack of a session runs again. */
export function afterSignIn(steps: {
  clearNeedsToken: () => void;
  refreshHarnesses: () => void;
  refresh: () => Promise<unknown>;
}): void {
  steps.clearNeedsToken();
  // The first harnesses check ran without a session and failed; the Doctor gate needs its answer.
  steps.refreshHarnesses();
  void steps.refresh().catch(() => {});
}

const ENTRY_KEY = "boof.doctor.entry";

/** Remembers the page the app was opened on while the doctor shows, so a reload keeps it. */
export function rememberEntry(storage: Pick<Storage, "setItem">, route: Route | null): void {
  if (!route || route.name === "doctor") return;
  try {
    storage.setItem(ENTRY_KEY, formatRoute(route));
  } catch {
    /* storage may be unavailable: Continue then falls back to the Overview */
  }
}

/** The remembered entry page, or null. */
export function recallEntry(storage: Pick<Storage, "getItem">): Route | null {
  try {
    const path = storage.getItem(ENTRY_KEY);
    const route = path ? parseRoute(path) : null;
    return route && route.name !== "doctor" ? route : null;
  } catch {
    return null;
  }
}

export function forgetEntry(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(ENTRY_KEY);
  } catch {
    /* nothing to forget */
  }
}
