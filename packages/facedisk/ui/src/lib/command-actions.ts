import type { OrchestrationProfile, Project, Scope } from "@boof/heart/schema";
import type { EpicView, PlanSummary, TaskView } from "../api.js";
import type { Route, SettingsPageId } from "./route.js";
import type { ThemePref } from "./theme.js";
import { statusLabel } from "./status.js";
import { groupTasks } from "./task-groups.js";
import { emptyDraft, loadDraft, saveDraft } from "./wizard.js";

export type ActionGroup = "Go to" | "Projects" | "Tasks" | "Actions";

/** One thing the user can do from the palette or the console. */
export interface CommandAction {
  /** Stable across renders and releases: the console and tests address actions by it. */
  id: string;
  label: string;
  group: ActionGroup;
  /** What the palette matches against (defaults to the label). */
  searchValue: string;
  keywords: string[];
  /** For actions a slash verb aims at something (a task, an epic, a plan, a project): its name. */
  targetTitle?: string;
  /** Full hierarchy target set, including targets omitted from the available actions. */
  targetUniverse?: { id: string; title: string; reason?: string }[];
  targetUniverseKind?: "move" | "subtask";
  /** The key needs one of these scopes; the server stays the judge. */
  requiredScope?: Scope | Scope[];
  disabled?: boolean;
  /** A short note beside the label ("current", a task's status). */
  meta?: string;
  /** `args` is what the console user typed after the verb; the palette passes none. */
  run(args?: string): Promise<void> | void;
}

/** The effects an action can have, supplied by the screen (toasts, refresh and dialogs live there). */
export interface ActionEffects {
  navigate(to: Route): void;
  selectProject(id: string): void;
  setTheme(pref: ThemePref): void;
  /** Ask before stopping a task; the confirmation belongs to the caller. */
  requestStop(task: TaskView): Promise<void> | void;
  activatePlan(pid: string, plan: PlanSummary): Promise<void> | void;
  queueTask(pid: string, taskId: string): Promise<void> | void;
  setRunner(enabled: boolean): Promise<void> | void;
  /** Make a profile the active one (`settings.activeProfile`). */
  setProfile?(id: string): Promise<void> | void;
  /** Open the new-plan flow. Without it the console opens the plan wizard. */
  openNewPlan?(pid: string, title?: string): void;
  /** Create an epic with this name and refresh. */
  createEpic(pid: string, title: string): Promise<void> | void;
  /** Take the user to where an epic is named (the Manage epics sheet). */
  openNewEpic(pid: string): void;
  /** Start a new assistant conversation for the project; pending changes stay until they expire. */
  resetAssistant(pid: string): Promise<void> | void;
  /** Change a task's epic or parent; null clears it. */
  moveTask(
    pid: string,
    taskId: string,
    move: { epicId: string | null } | { parentId: string | null },
  ): Promise<void> | void;
}

export interface ActionContext {
  /** The selected project, or null before one is chosen. */
  pid: string | null;
  projects: Project[];
  tasks: TaskView[];
  plans: PlanSummary[];
  /** The project's epics, archived ones too. */
  epics: EpicView[];
  /** The task open on screen, which the hierarchy actions apply to; null elsewhere. */
  currentTask: TaskView | null;
  runnerEnabled: boolean;
  /** The settings' profiles and the active one; absent profiles offer no switch actions. */
  profiles?: OrchestrationProfile[];
  activeProfile?: string | null;
  settingsLoaded: boolean;
  effects: ActionEffects;
}

const SETTINGS_PAGES: { page: SettingsPageId; label: string }[] = [
  { page: "project", label: "Go to Settings › Project" },
  { page: "agents", label: "Go to Settings › Agents" },
  { page: "profiles", label: "Go to Settings › Profiles" },
  { page: "budgets", label: "Go to Settings › Budgets" },
  { page: "keys", label: "Go to Settings › API keys" },
  { page: "automation", label: "Go to Settings › Automation" },
];

const THEMES: { pref: ThemePref; label: string }[] = [
  { pref: "light", label: "Use light theme" },
  { pref: "dark", label: "Use dark theme" },
  { pref: "system", label: "Use system theme" },
];

/** Every action the palette and the console offer in the current context. */
/** Opens the plan wizard; a title given to /plan starts a new draft with it (one in progress is kept). */
function openWizard(fx: Pick<ActionEffects, "navigate">, pid: string, title?: string) {
  try {
    if (title && !loadDraft(window.sessionStorage, pid))
      saveDraft(window.sessionStorage, pid, { ...emptyDraft(), title });
  } catch {
    /* no storage: the wizard opens without the title */
  }
  fx.navigate({ name: "wizard", pid });
}

export function createCommandActions(ctx: ActionContext): CommandAction[] {
  const { pid, effects: fx } = ctx;
  const out: CommandAction[] = [];
  const add = (a: Omit<CommandAction, "searchValue" | "keywords"> & Partial<CommandAction>) =>
    out.push({ searchValue: a.label, keywords: [], ...a });
  const go = (id: string, label: string, to: Route) =>
    add({ id, label, group: "Go to", run: () => fx.navigate(to) });

  go("go-inbox", "Go to Inbox", { name: "inbox" });
  if (pid) {
    go("go-overview", "Go to Overview", { name: "overview", pid });
    go("go-tasks", "Go to Tasks", { name: "tasks", pid });
    go("go-plans", "Go to Plans", { name: "plans", pid });
    for (const { page, label } of SETTINGS_PAGES)
      go(`go-settings-${page}`, label, { name: "settings", pid, page });
  }

  for (const p of ctx.projects.filter((x) => !x.archived)) {
    add({
      id: `switch-project-${p.id}`,
      targetTitle: p.name,
      label: `Switch to ${p.name}`,
      group: "Projects",
      searchValue: `Switch to project ${p.name}`,
      keywords: ["project", p.id],
      ...(p.id === pid ? { meta: "current" } : {}),
      run: () => fx.selectProject(p.id),
    });
  }

  if (pid) {
    for (const t of ctx.tasks) {
      add({
        id: `open-task-${t.frontmatter.id}`,
        targetTitle: t.frontmatter.title,
        label: t.frontmatter.title,
        group: "Tasks",
        searchValue: `Open task ${t.frontmatter.title} ${t.frontmatter.id}`,
        keywords: ["open", "task", t.frontmatter.id],
        meta: statusLabel(t.frontmatter.status),
        run: () => fx.navigate({ name: "task", pid, taskId: t.frontmatter.id, view: "edit" }),
      });
    }

    const groups = groupTasks(ctx.tasks, ctx.plans);
    const proposed = new Set(groups.proposed.map((t) => t.frontmatter.id));
    add({
      id: "new-task",
      label: "New task",
      group: "Actions",
      keywords: ["create", "task"],
      requiredScope: "tasks:write",
      run: () => fx.navigate({ name: "task", pid, taskId: "__new__", view: "edit" }),
    });
    add({
      id: "new-plan",
      label: "New plan",
      group: "Actions",
      keywords: ["create", "plan", "wizard", "/plan"],
      requiredScope: "plans:write",
      run: (args) =>
        fx.openNewPlan
          ? fx.openNewPlan(pid, args?.trim() || undefined)
          : openWizard(fx, pid, args?.trim() || undefined),
    });
    for (const plan of groups.needsYou.flatMap((n) => (n.kind === "draft-plan" ? [n.plan] : []))) {
      add({
        id: `activate-plan-${plan.id}`,
        targetTitle: plan.title,
        label: `Create tasks from plan: ${plan.title}`,
        group: "Actions",
        searchValue: `Create tasks from plan: ${plan.title} ${plan.id}`,
        keywords: ["activate", "plan", "tasks", plan.id],
        requiredScope: "plans:write",
        run: () => fx.activatePlan(pid, plan),
      });
    }
    for (const t of ctx.tasks.filter((x) => x.frontmatter.status === "draft")) {
      const label = `${proposed.has(t.frontmatter.id) ? "Queue proposed task" : "Queue"}: ${t.frontmatter.title}`;
      add({
        id: `queue-${t.frontmatter.id}`,
        targetTitle: t.frontmatter.title,
        label,
        group: "Actions",
        searchValue: `${label} ${t.frontmatter.id}`,
        keywords: ["queue", "task", t.frontmatter.id],
        requiredScope: "tasks:write",
        run: () => fx.queueTask(pid, t.frontmatter.id),
      });
    }
    for (const t of groups.running) {
      add({
        id: `stop-${t.frontmatter.id}`,
        targetTitle: t.frontmatter.title,
        label: `Stop: ${t.frontmatter.title}`,
        group: "Actions",
        searchValue: `Stop: ${t.frontmatter.title} ${t.frontmatter.id}`,
        keywords: ["stop", "task", t.frontmatter.id],
        requiredScope: "tasks:control",
        run: () => fx.requestStop(t),
      });
    }

    add({
      id: "new-epic",
      label: "New epic",
      group: "Actions",
      keywords: ["create", "epic", "group"],
      requiredScope: "tasks:write",
      run: (args) => {
        const title = args?.trim();
        return title ? fx.createEpic(pid, title) : fx.openNewEpic(pid);
      },
    });
    add({
      id: "assistant.new",
      label: "New assistant conversation",
      group: "Actions",
      keywords: ["/new", "assistant", "reset"],
      requiredScope: "tasks:read",
      run: () => fx.resetAssistant(pid),
    });
    if (ctx.currentTask) hierarchyActions(pid, ctx, ctx.currentTask, add);
  }

  add({
    id: "toggle-runner",
    label: ctx.runnerEnabled ? "Pause the runner" : "Start the runner",
    group: "Actions",
    keywords: ["runner", "pause", "start"],
    requiredScope: ["runner:control", "settings:write"],
    disabled: !ctx.settingsLoaded,
    run: () => fx.setRunner(ctx.runnerEnabled),
  });
  for (const p of ctx.profiles ?? []) {
    add({
      id: `use-profile-${p.id}`,
      targetTitle: p.name,
      label: `Use profile: ${p.name}`,
      group: "Actions",
      searchValue: `Use profile: ${p.name} ${p.id}`,
      keywords: ["profile", "roles", p.id],
      requiredScope: "settings:write",
      ...(p.id === ctx.activeProfile ? { meta: "active" } : {}),
      disabled: !fx.setProfile,
      run: () => fx.setProfile?.(p.id),
    });
  }
  for (const { pref, label } of THEMES) {
    add({
      id: `theme-${pref}`,
      label,
      group: "Actions",
      keywords: ["theme"],
      run: () => fx.setTheme(pref),
    });
  }
  return out;
}

type Add = (a: Omit<CommandAction, "searchValue" | "keywords"> & Partial<CommandAction>) => void;

/** Move the open task to an epic, under a parent, or out of either. One level of subtasks only. */
function hierarchyActions(pid: string, ctx: ActionContext, task: TaskView, add: Add) {
  const fx = ctx.effects;
  const f = task.frontmatter;
  const title = f.title;
  const topLevel = !f.parentId;
  const move = (m: { epicId: string | null } | { parentId: string | null }) => () =>
    fx.moveTask(pid, f.id, m);
  const epicTargets = ctx.epics.map((e) => ({
    id: e.id,
    title: e.title,
    reason: e.archived
      ? `epic ${e.title} is archived`
      : e.id === f.epicId
        ? `already in epic ${e.title}`
        : undefined,
  }));
  const taskTargets = ctx.tasks.map((p) => {
    const pf = p.frontmatter;
    return {
      id: pf.id,
      title: pf.title,
      reason:
        pf.id === f.id
          ? "a task cannot be a subtask of itself"
          : pf.id === f.parentId
            ? `already a subtask of ${pf.title}`
            : pf.parentId || pf.status === "archived"
              ? `task ${pf.title} is not available as a parent`
              : undefined,
    };
  });

  if (f.parentId) {
    add({
      id: "detach-parent",
      targetUniverse: taskTargets,
      targetUniverseKind: "subtask",
      label: "Detach from parent",
      group: "Actions",
      searchValue: `Detach from parent ${title}`,
      keywords: ["detach", "parent", "subtask", f.id],
      requiredScope: "tasks:write",
      run: move({ parentId: null }),
    });
  }
  if (f.epicId) {
    add({
      id: "detach-epic",
      targetUniverse: epicTargets,
      targetUniverseKind: "move",
      label: "Detach from epic",
      group: "Actions",
      searchValue: `Detach from epic ${title}`,
      keywords: ["detach", "epic", f.id],
      requiredScope: "tasks:write",
      run: move({ epicId: null }),
    });
  }
  // A subtask's epic is its parent's, so only a top-level task moves between epics.
  if (topLevel) {
    for (const e of ctx.epics) {
      if (e.archived || e.id === f.epicId) continue;
      add({
        id: `move-epic-${e.id}`,
        targetTitle: e.title,
        targetUniverse: epicTargets,
        targetUniverseKind: "move",
        label: `Move to epic: ${e.title}`,
        group: "Actions",
        searchValue: `Move to epic: ${e.title} ${e.id} (${title})`,
        keywords: ["move", "epic", e.id],
        requiredScope: "tasks:write",
        run: move({ epicId: e.id }),
      });
    }
  }
  // A task with subtasks cannot become one itself.
  if (topLevel && !(task.subtasks && task.subtasks.total > 0)) {
    for (const p of ctx.tasks) {
      const pf = p.frontmatter;
      if (pf.id === f.id || pf.parentId || pf.status === "archived") continue;
      add({
        id: `make-subtask-${pf.id}`,
        targetTitle: pf.title,
        targetUniverse: taskTargets,
        targetUniverseKind: "subtask",
        label: `Make subtask of: ${pf.title}`,
        group: "Actions",
        searchValue: `Make subtask of: ${pf.title} ${pf.id} (${title})`,
        keywords: ["subtask", "parent", "move", pf.id],
        requiredScope: "tasks:write",
        run: move({ parentId: pf.id }),
      });
    }
  }
}
