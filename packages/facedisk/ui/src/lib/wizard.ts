import type { Goal, GoalInput, Plan } from "../api.js";
import type { HarnessStatus } from "../api-types.js";
import { slugify } from "./goal-form.js";

export const OUTCOME_MAX = 20_000;
export const TITLE_MAX = 120;

export type WizardStep = "outcome" | "about" | "tasks";

/** One task in the wizard's list. `goalId` is set for a task that already exists as a goal. */
export interface WizardItem {
  key: string;
  goalId?: string;
  title: string;
  details: string;
  /** Depends on the item above it. */
  afterPrevious: boolean;
}

/** What "About this project" holds; it becomes the shared fields of every goal. */
export interface WizardProject {
  stack: string;
  testCommand: string;
  doRules: string;
  dontRules: string;
}

export interface WizardDraft {
  outcome: string;
  title: string;
  useAgent: boolean;
  tool: string;
  model: string;
  note: string;
  project: WizardProject;
  items: WizardItem[];
  /** The draft plan, once it exists. */
  planId: string | null;
  step: WizardStep;
}

export const emptyDraft = (): WizardDraft => ({
  outcome: "",
  title: "",
  useAgent: false,
  tool: "",
  model: "",
  note: "",
  project: { stack: "", testCommand: "", doRules: "", dontRules: "" },
  items: [],
  planId: null,
  step: "outcome",
});

/** The title the user typed, else the first line of the outcome (at most TITLE_MAX characters). */
export function planTitle(d: Pick<WizardDraft, "title" | "outcome">): string {
  const own = d.title.trim();
  if (own) return own.slice(0, TITLE_MAX);
  const first = d.outcome.split("\n").find((l) => l.trim()) ?? "";
  return first.trim().slice(0, TITLE_MAX);
}

export function outcomeProblem(outcome: string): string | null {
  if (!outcome.trim()) return "Say what you want to end up with.";
  if (outcome.length > OUTCOME_MAX) return `Keep it under ${OUTCOME_MAX} characters.`;
  return null;
}

/** True when any of the project answers is filled in. */
export const hasAbout = (p: WizardProject): boolean =>
  Object.values(p).some((v) => v.trim() !== "");

/** The step after the outcome: the project facts are asked once per project. */
export const afterOutcome = (aboutAlreadyDone: boolean): WizardStep =>
  aboutAlreadyDone ? "tasks" : "about";

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The shared goal spec for one task; `details` becomes the goal text. */
export function sharedSpec(p: WizardProject, details: string, title: string): Goal["spec"] {
  return {
    goal: details.trim() || title.trim(),
    stack: p.stack.trim() || "Not specified",
    rules: {
      do: lines(p.doRules).length
        ? lines(p.doRules)
        : ["Follow the project's existing conventions"],
      dont: lines(p.dontRules),
    },
    tests: {
      strategy: "Run the project's tests",
      technology: p.stack.trim() || "Not specified",
      run: p.testCommand.trim() || "No test command set",
    },
  };
}

/** Ids from titles: lowercase slugs, a clash gets -2, -3… ; an existing goal keeps its id. */
export function assignIds(items: readonly WizardItem[], taken: readonly string[] = []): string[] {
  const used = new Set(taken);
  const ids: string[] = [];
  for (const it of items) {
    if (it.goalId) {
      used.add(it.goalId);
      ids.push(it.goalId);
    } else ids.push("");
  }
  return items.map((it, i) => {
    if (ids[i]) return ids[i];
    const base = slugify(it.title).slice(0, 60).replace(/-+$/, "") || "task";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

export function itemsProblems(items: readonly WizardItem[]): string[] {
  const out: string[] = [];
  if (items.length === 0) out.push("Add at least one task.");
  if (items.some((i) => !i.title.trim())) out.push("Every task needs a title.");
  if (items.some((i) => i.title.length > 500)) out.push("Keep titles under 500 characters.");
  return out;
}

/** The goals to save: shared fields, order as listed, each optionally depending on the one above. */
export function buildGoalInputs(
  items: readonly WizardItem[],
  project: WizardProject,
  existing: readonly Goal[] = [],
): GoalInput[] {
  const byId = new Map(existing.map((g) => [g.id, g]));
  const ids = assignIds(
    items,
    existing.map((g) => g.id).filter((id) => !items.some((i) => i.goalId === id)),
  );
  return items.map((it, i) => {
    const old = it.goalId ? byId.get(it.goalId) : undefined;
    const spec = old
      ? { ...old.spec, goal: it.details.trim() || it.title.trim() }
      : sharedSpec(project, it.details, it.title);
    const keepDeps = old && !it.afterPrevious ? old.dependsOn.filter((d) => ids.includes(d)) : [];
    return {
      id: ids[i],
      title: it.title.trim(),
      order: i + 1,
      dependsOn: it.afterPrevious && i > 0 ? [ids[i - 1]] : keepDeps,
      ...(old?.model ? { model: old.model } : {}),
      spec,
    };
  });
}

/** The list the wizard edits, from a plan's goals (an agent's draft or a restored plan). */
export function itemsFromGoals(goals: readonly Goal[]): WizardItem[] {
  return goals.map((g, i) => ({
    key: g.id,
    goalId: g.id,
    title: g.title,
    details: g.spec.goal === g.title ? "" : g.spec.goal,
    afterPrevious: i > 0 && g.dependsOn.length === 1 && g.dependsOn[0] === goals[i - 1].id,
  }));
}

let counter = 0;
export function newItem(title = ""): WizardItem {
  counter += 1;
  return { key: `new-${counter}`, title, details: "", afterPrevious: false };
}

export function moveItem(items: readonly WizardItem[], from: number, to: number): WizardItem[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length)
    return [...items];
  const next = [...items];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** The tools an agent draft can use: installed ones only. */
export function installedTools(status: HarnessStatus | null): string[] {
  if (!status) return [];
  return Object.entries(status.tools)
    .filter(([, i]) => i.installed)
    .map(([id]) => id);
}

/** Installed tools that cannot start for this project, with the server's reason. */
export function blockedTools(status: HarnessStatus | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (status)
    for (const [id, i] of Object.entries(status.tools))
      if (i.installed && i.startBlock) out[id] = i.startBlock;
  return out;
}

/** Installed tools that can start: the ones an agent draft may use. */
export function readyTools(status: HarnessStatus | null): string[] {
  const blocked = blockedTools(status);
  return installedTools(status).filter((id) => !blocked[id]);
}

/** Why "Let an agent write the tasks" is not available, or null when it is. */
export function agentUnavailableReason(status: HarnessStatus | null): string | null {
  if (!status) return "Checking which coding agents are installed…";
  if (!status.anyInstalled)
    return "No coding agent is installed on this computer. Install one (Settings › Agents), or write the tasks yourself.";
  if (readyTools(status).length === 0) {
    const first = Object.values(blockedTools(status))[0];
    return `No installed coding agent can start for this project. ${first ?? ""}`.trim();
  }
  return null;
}

interface RoleLike {
  tool: string;
  model: string;
}
interface SettingsLike {
  roles: { planner: RoleLike };
  profiles?: { id: string; roles: { planner: RoleLike | null } }[];
  activeProfile?: string | null;
}

/**
 * The agent preselected: the active profile's advisor (planner), else the planner role, if it
 * is ready; else the first ready one. `installed` lists the tools that can start.
 */
export function defaultAgent(
  settings: SettingsLike | null,
  installed: readonly string[],
): { tool: string; model: string } {
  const prof = settings?.profiles?.find((p) => p.id === settings.activeProfile);
  for (const pick of [prof?.roles.planner, settings?.roles.planner])
    if (pick && installed.includes(pick.tool)) return { tool: pick.tool, model: pick.model };
  return { tool: installed[0] ?? "", model: "" };
}

const FAILURE_MAX = 300;

/** Drops what a user must not see or does not need: file paths, keys and tokens. */
function cleanReason(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [token]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=\S+/g, "$1=[hidden]")
    .replace(/(?:[A-Za-z]:\\|~\/|\/)(?:[\w.@+-]+[\\/])+[\w.@+-]*/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Why a plan-draft task failed: the first non-empty line of its "Not started" note, else of
 * its log (headings skipped), cleaned of paths and secrets and cut short. Null when the task
 * did not fail or says nothing.
 */
export function draftFailureReason(task: {
  frontmatter: { status: string };
  body: { log?: string };
}): string | null {
  if (task.frontmatter.status !== "failed" && task.frontmatter.status !== "stopped") return null;
  const lines = (task.body.log ?? "").split(/\r?\n/);
  const at = lines.findIndex((l) => /^#+\s*Not started\s*$/i.test(l.trim()));
  const pool = at >= 0 ? lines.slice(at + 1) : lines;
  const first = pool.find((l) => l.trim() && !/^#+\s/.test(l.trim()));
  if (!first) return null;
  const clean = cleanReason(first);
  if (!clean) return null;
  return clean.length > FAILURE_MAX ? `${clean.slice(0, FAILURE_MAX - 1)}…` : clean;
}

/** The next actions for a failed draft: always another agent; project settings when it points there. */
export function draftFailureActions(reason: string | null): ("change-agent" | "settings")[] {
  return reason && /settings|api key|authenticat|gateway/i.test(reason)
    ? ["change-agent", "settings"]
    : ["change-agent"];
}

// ---- draft kept in sessionStorage, dismissal in localStorage ----

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const draftKey = (pid: string) => `boof.wizard.draft.${pid}`;
const dismissKey = (pid: string) => `boof.wizard.dismissed.${pid}`;

export function saveDraft(store: KeyValueStore, pid: string, draft: WizardDraft): void {
  try {
    store.setItem(draftKey(pid), JSON.stringify(draft));
  } catch {
    /* storage full or blocked: the draft is simply not kept */
  }
}

export function loadDraft(store: KeyValueStore, pid: string): WizardDraft | null {
  try {
    const raw = store.getItem(draftKey(pid));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<WizardDraft>;
    if (typeof v !== "object" || v === null || typeof v.outcome !== "string") return null;
    const base = emptyDraft();
    return {
      ...base,
      ...v,
      project: { ...base.project, ...(v.project ?? {}) },
      items: Array.isArray(v.items) ? v.items : [],
    };
  } catch {
    return null;
  }
}

export const clearDraft = (store: KeyValueStore, pid: string) => store.removeItem(draftKey(pid));

/** The project's saved answers (kept in the data root with the project), or null before any. */
export const savedAbout = (
  project: { planDefaults?: WizardProject } | null,
): WizardProject | null => (project?.planDefaults ? { ...project.planDefaults } : null);

/** "About this project" is asked once per project: done when the server holds the answers. */
export const aboutDone = (project: { planDefaults?: WizardProject } | null): boolean =>
  savedAbout(project) !== null;

export function isDismissed(store: KeyValueStore, pid: string): boolean {
  try {
    return store.getItem(dismissKey(pid)) === "1";
  } catch {
    return false;
  }
}
export function dismissWizard(store: KeyValueStore, pid: string): void {
  try {
    store.setItem(dismissKey(pid), "1");
  } catch {
    /* ignored: it will open again */
  }
}

/** The wizard opens by itself for a project with no tasks and no plans, unless dismissed. */
export function shouldAutoOpen(o: {
  loaded: boolean;
  taskCount: number;
  planCount: number;
  dismissed: boolean;
}): boolean {
  return o.loaded && o.taskCount === 0 && o.planCount === 0 && !o.dismissed;
}
