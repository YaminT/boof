import type { Project, Scope } from "@boof-runner/shared/schema";
import type { PlanSummary, TaskView } from "../api.js";
import type { Route, SettingsPageId } from "./route.js";
import type { ThemePref } from "./theme.js";
import { statusLabel } from "./status.js";
import { groupTasks } from "./task-groups.js";

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
  /** The key needs one of these scopes; the server stays the judge. */
  requiredScope?: Scope | Scope[];
  disabled?: boolean;
  /** A short note beside the label ("current", a task's status). */
  meta?: string;
  run(): Promise<void> | void;
}

/** The effects an action can have, supplied by the screen (toasts, refresh and dialogs live there). */
export interface ActionEffects {
  navigate(to: Route): void;
  selectProject(id: string): void;
  setTheme(pref: ThemePref): void;
  /** Ask before stopping a task; the confirmation belongs to the caller. */
  requestStop(task: TaskView): void;
  activatePlan(pid: string, plan: PlanSummary): Promise<void> | void;
  queueTask(pid: string, taskId: string): Promise<void> | void;
  setRunner(enabled: boolean): Promise<void> | void;
}

export interface ActionContext {
  /** The selected project, or null before one is chosen. */
  pid: string | null;
  projects: Project[];
  tasks: TaskView[];
  plans: PlanSummary[];
  runnerEnabled: boolean;
  settingsLoaded: boolean;
  effects: ActionEffects;
}

const SETTINGS_PAGES: { page: SettingsPageId; label: string }[] = [
  { page: "project", label: "Go to Settings › Project" },
  { page: "agents", label: "Go to Settings › Agents" },
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
        label: t.frontmatter.title,
        group: "Tasks",
        searchValue: `Open task ${t.frontmatter.title} ${t.frontmatter.id}`,
        keywords: ["open", "task", t.frontmatter.id],
        meta: statusLabel(t.frontmatter.status),
        run: () => fx.navigate({ name: "task", pid, taskId: t.frontmatter.id, view: "edit" }),
      });
    }

    const groups = groupTasks(ctx.tasks, ctx.plans);
    const proposed = new Set(
      groups.needsYou.flatMap((n) => (n.kind === "proposed" ? [n.task.frontmatter.id] : [])),
    );
    add({
      id: "new-task",
      label: "New task",
      group: "Actions",
      keywords: ["create", "task"],
      requiredScope: "tasks:write",
      run: () => fx.navigate({ name: "task", pid, taskId: "__new__", view: "edit" }),
    });
    for (const plan of groups.needsYou.flatMap((n) => (n.kind === "draft-plan" ? [n.plan] : []))) {
      add({
        id: `activate-plan-${plan.id}`,
        label: `Activate plan: ${plan.title}`,
        group: "Actions",
        searchValue: `Activate plan: ${plan.title} ${plan.id}`,
        keywords: ["activate", "plan", plan.id],
        requiredScope: "plans:write",
        run: () => fx.activatePlan(pid, plan),
      });
    }
    for (const t of ctx.tasks.filter((x) => x.frontmatter.status === "draft")) {
      const label = `${proposed.has(t.frontmatter.id) ? "Queue proposed task" : "Queue"}: ${t.frontmatter.title}`;
      add({
        id: `queue-${t.frontmatter.id}`,
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
        label: `Stop: ${t.frontmatter.title}`,
        group: "Actions",
        searchValue: `Stop: ${t.frontmatter.title} ${t.frontmatter.id}`,
        keywords: ["stop", "task", t.frontmatter.id],
        requiredScope: "tasks:control",
        run: () => fx.requestStop(t),
      });
    }
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
