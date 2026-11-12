import { describe, expect, it, vi } from "vitest";
import type { Project, Scope } from "@boof/heart/schema";
import type { EpicView, PlanSummary, TaskView } from "../api.js";
import {
  CONSOLE_VERBS,
  availableActions,
  formatConsoleResult,
  resolveConsoleCommand,
  type ConsoleResolution,
} from "./console-command.js";
import { createCommandActions, type ActionEffects } from "./command-actions.js";

const task = (id: string, status: string, title = id): TaskView =>
  ({
    projectId: "alpha",
    frontmatter: { id, title, status, created: "2026-01-01" },
    body: {},
  }) as unknown as TaskView;
const project = (id: string, name = id) => ({ id, name, archived: false }) as unknown as Project;

function setup(over: { runnerEnabled?: boolean } = {}) {
  const effects: ActionEffects = {
    navigate: vi.fn(),
    selectProject: vi.fn(),
    setTheme: vi.fn(),
    requestStop: vi.fn(),
    activatePlan: vi.fn(),
    queueTask: vi.fn(),
    setRunner: vi.fn(),
    createEpic: vi.fn(),
    openNewEpic: vi.fn(),
    moveTask: vi.fn(),
    resetAssistant: vi.fn(),
  };
  const actions = createCommandActions({
    pid: "alpha",
    projects: [project("alpha", "Alpha"), project("beta", "Beta site")],
    tasks: [
      task("t1", "draft", "Fix login"),
      task("t2", "draft", "Fix logout"),
      task("t3", "running", "Build docs"),
    ],
    plans: [
      {
        id: "p1",
        title: "Launch",
        status: "draft",
        created: "2026-01-01",
      } as unknown as PlanSummary,
    ],
    epics: [
      { id: "checkout", title: "Checkout rework", archived: false },
      { id: "search", title: "Search", archived: false },
    ] as unknown as EpicView[],
    currentTask: task("t1", "draft", "Fix login"),
    runnerEnabled: over.runnerEnabled ?? false,
    settingsLoaded: true,
    effects,
  });
  return { actions, effects };
}
function setupWith(o: { ownEpic?: string; parent?: string }) {
  const effects = {
    navigate: vi.fn(),
    selectProject: vi.fn(),
    setTheme: vi.fn(),
    requestStop: vi.fn(),
    activatePlan: vi.fn(),
    queueTask: vi.fn(),
    setRunner: vi.fn(),
    createEpic: vi.fn(),
    openNewEpic: vi.fn(),
    moveTask: vi.fn(),
    resetAssistant: vi.fn(),
  };
  const cur = {
    projectId: "alpha",
    frontmatter: {
      id: "t1",
      title: "Fix login",
      status: "draft",
      epicId: o.ownEpic,
      parentId: o.parent,
    },
    body: {},
    epicId: o.ownEpic,
  } as unknown as TaskView;
  const actions = createCommandActions({
    pid: "alpha",
    projects: [],
    tasks: [cur, task("t2", "draft", "Fix logout")],
    plans: [],
    epics: [{ id: "checkout", title: "Checkout rework", archived: false }] as unknown as EpicView[],
    currentTask: cur,
    runnerEnabled: false,
    settingsLoaded: true,
    effects,
  });
  return { actions, effects };
}
const idOf = (r: ConsoleResolution) => (r.kind === "run" ? r.action.id : r);

describe("resolveConsoleCommand", () => {
  const { actions } = setup();

  it("treats empty input as unknown", () => {
    expect(resolveConsoleCommand("   ", actions)).toMatchObject({ kind: "unknown", input: "" });
  });

  it("accepts palette labels, ignoring case and spacing", () => {
    expect(idOf(resolveConsoleCommand("go to  tasks", actions))).toBe("go-tasks");
    expect(idOf(resolveConsoleCommand("Queue: Fix login", actions))).toBe("queue-t1");
    expect(idOf(resolveConsoleCommand("Start the runner", actions))).toBe("toggle-runner");
  });

  it("accepts an action id", () => {
    expect(idOf(resolveConsoleCommand("theme-dark", actions))).toBe("theme-dark");
  });

  it("matches unscoped actions by unique keyword, never scoped ones", () => {
    expect(idOf(resolveConsoleCommand("dark theme", actions))).toBe("theme-dark");
    expect(resolveConsoleCommand("queue", actions).kind).toBe("unknown");
    expect(resolveConsoleCommand("stop", actions).kind).toBe("unknown");
  });

  it("resolves slash verbs to actions", () => {
    expect(resolveConsoleCommand("/task Write the docs", actions)).toMatchObject({
      kind: "run",
      args: "Write the docs",
    });
    expect(idOf(resolveConsoleCommand("/task Write the docs", actions))).toBe("new-task");
    expect(idOf(resolveConsoleCommand("/queue t1", actions))).toBe("queue-t1");
    expect(idOf(resolveConsoleCommand("/queue fix logout", actions))).toBe("queue-t2");
    expect(idOf(resolveConsoleCommand("/stop build", actions))).toBe("stop-t3");
    expect(idOf(resolveConsoleCommand("/open fix login", actions))).toBe("open-task-t1");
    expect(idOf(resolveConsoleCommand("/activate launch", actions))).toBe("activate-plan-p1");
    expect(idOf(resolveConsoleCommand("/project beta", actions))).toBe("switch-project-beta");
    expect(idOf(resolveConsoleCommand("/go plans", actions))).toBe("go-plans");
    expect(idOf(resolveConsoleCommand("/go settings keys", actions))).toBe("go-settings-keys");
    expect(idOf(resolveConsoleCommand("/theme light", actions))).toBe("theme-light");
    expect(idOf(resolveConsoleCommand("/new", actions))).toBe("assistant.new");
    expect(idOf(resolveConsoleCommand("new assistant conversation", actions))).toBe(
      "assistant.new",
    );
  });

  it("resolves the hierarchy verbs", () => {
    expect(resolveConsoleCommand("/epic Payments", actions)).toMatchObject({
      kind: "run",
      args: "Payments",
    });
    expect(idOf(resolveConsoleCommand("/epic Payments", actions))).toBe("new-epic");
    expect(idOf(resolveConsoleCommand("/epic", actions))).toBe("new-epic");
    expect(idOf(resolveConsoleCommand("/move checkout", actions))).toBe("move-epic-checkout");
    expect(idOf(resolveConsoleCommand("/move search", actions))).toBe("move-epic-search");
    expect(idOf(resolveConsoleCommand("/subtask fix logout", actions))).toBe("make-subtask-t2");
    expect(resolveConsoleCommand("/move none", actions).kind).toBe("unknown"); // nothing to detach: own epic is unset
    expect(resolveConsoleCommand("/detach parent", actions).kind).toBe("unknown"); // it has no parent
    expect(resolveConsoleCommand("/detach nonsense", actions).kind).toBe("unknown");
  });

  it("resolves /detach and /move none when there is something to detach", () => {
    const { actions: a } = setupWith({ ownEpic: "checkout", parent: "t2" });
    expect(idOf(resolveConsoleCommand("/detach epic", a))).toBe("detach-epic");
    expect(idOf(resolveConsoleCommand("/move none", a))).toBe("detach-epic");
    expect(idOf(resolveConsoleCommand("/detach parent", a))).toBe("detach-parent");
  });

  it("matches /move and /subtask on the target only, never the current task's title", () => {
    // the current task is "Fix login": its words are no reason to pick the only other target
    const { actions: one } = setupWith({});
    expect(resolveConsoleCommand("/move login", one).kind).toBe("unknown");
    expect(resolveConsoleCommand("/move epic", one).kind).toBe("unknown");
    expect(resolveConsoleCommand("/subtask login", one).kind).toBe("unknown");
    expect(idOf(resolveConsoleCommand("/move checkout", one))).toBe("move-epic-checkout");
  });

  it("prefers an exact title over a longer one", () => {
    const mk = (id: string, title: string) =>
      ({ id, title, archived: false }) as unknown as EpicView;
    const effects = setupWith({}).effects;
    const actions = createCommandActions({
      pid: "alpha",
      projects: [],
      tasks: [],
      plans: [],
      epics: [mk("e1", "API"), mk("e2", "API v2")],
      currentTask: task("t1", "draft", "Zed"),
      runnerEnabled: false,
      settingsLoaded: true,
      effects,
    });
    expect(idOf(resolveConsoleCommand("/move api", actions))).toBe("move-epic-e1");
    expect(idOf(resolveConsoleCommand("/move API v2", actions))).toBe("move-epic-e2");
    expect(idOf(resolveConsoleCommand("/move e2", actions))).toBe("move-epic-e2");
    expect(resolveConsoleCommand("/move ap", actions).kind).toBe("unknown");
  });

  it("checks every epic before substring fallback and explains current or archived exact matches", () => {
    const effects = setupWith({}).effects;
    const current = task("t1", "draft", "Fix login");
    const actions = createCommandActions({
      pid: "alpha",
      projects: [],
      tasks: [current],
      plans: [],
      epics: [
        { id: "api", title: "API", archived: false },
        { id: "api-v2", title: "API v2", archived: false },
        { id: "old", title: "Old API", archived: true },
      ] as unknown as EpicView[],
      currentTask: {
        ...current,
        frontmatter: { ...current.frontmatter, epicId: "api" },
        epicId: "api",
      } as TaskView,
      runnerEnabled: false,
      settingsLoaded: true,
      effects,
    });
    expect(resolveConsoleCommand("/move API", actions)).toMatchObject({
      kind: "unknown",
      reason: "already in epic API",
    });
    expect(resolveConsoleCommand("/move Old API", actions)).toMatchObject({
      kind: "unknown",
      reason: "epic Old API is archived",
    });
  });

  it("checks current parent and self against all task targets before fallback", () => {
    const { actions } = setupWith({ parent: "t2" });
    expect(resolveConsoleCommand("/subtask Fix logout", actions)).toMatchObject({
      kind: "unknown",
      reason: "already a subtask of Fix logout",
    });
    expect(resolveConsoleCommand("/subtask Fix login", actions)).toMatchObject({
      kind: "unknown",
      reason: "a task cannot be a subtask of itself",
    });
  });

  it("refuses ambiguous or missing targets and says why", () => {
    const amb = resolveConsoleCommand("/queue fix", actions);
    expect(amb).toMatchObject({ kind: "unknown" });
    expect((amb as { reason?: string }).reason).toMatch(/more than one/i);
    expect(
      (resolveConsoleCommand("/queue nothing", actions) as { reason?: string }).reason,
    ).toMatch(/no match/i);
    expect((resolveConsoleCommand("/stop", actions) as { reason?: string }).reason).toMatch(
      /which/i,
    );
  });

  it("has no /project new: the palette has no such action", () => {
    expect(resolveConsoleCommand("/project new", actions).kind).toBe("unknown");
  });

  it("only flips the runner the way the user asked", () => {
    expect(idOf(resolveConsoleCommand("/runner start", actions))).toBe("toggle-runner");
    expect(resolveConsoleCommand("/runner pause", actions).kind).toBe("unknown");
    const on = setup({ runnerEnabled: true }).actions;
    expect(idOf(resolveConsoleCommand("/runner pause", on))).toBe("toggle-runner");
    expect(resolveConsoleCommand("/runner start", on).kind).toBe("unknown");
  });

  it("keeps the raw text, trimmed, for history", () => {
    expect(resolveConsoleCommand("  /nope  x ", actions)).toEqual({
      kind: "unknown",
      input: "/nope  x",
      reason: expect.any(String),
    });
  });
});

describe("availableActions", () => {
  const { actions } = setup();
  const names = (list: typeof actions) => list.map((a) => a.id);

  it("keeps everything when the server is the judge", () => {
    expect(availableActions(actions, "all")).toHaveLength(actions.length);
  });

  it("drops what a restricted key lacks, so the console cannot even resolve it", () => {
    const held = new Set<Scope>(["tasks:read"]);
    const got = availableActions(actions, held);
    expect(names(got)).not.toContain("queue-t1");
    expect(names(got)).not.toContain("stop-t3");
    expect(names(got)).not.toContain("toggle-runner");
    expect(names(got)).toContain("go-tasks");
    expect(resolveConsoleCommand("/queue t1", got).kind).toBe("unknown");
  });

  it("lets any one of several scopes through", () => {
    const held = new Set<Scope>(["settings:write"]);
    expect(names(availableActions(actions, held))).toContain("toggle-runner");
  });
});

describe("formatConsoleResult", () => {
  const { actions } = setup();
  it("is deterministic text", () => {
    expect(formatConsoleResult({ kind: "ok", action: actions[0]! })).toBe("ok: Go to Inbox");
    expect(
      formatConsoleResult({ kind: "error", action: actions[0]!, message: "403 forbidden" }),
    ).toBe("error: Go to Inbox: 403 forbidden");
    expect(
      formatConsoleResult({ kind: "unknown", input: "/nope", reason: "no such command" }),
    ).toBe(
      'unknown: "/nope" (no such command). Try a palette label or /task, /queue, /stop, /open, /go, /epic, /move, /subtask, /detach, /activate, /plan, /project, /runner, /theme, /new.',
    );
  });
});

describe("hint, /plan and intent suggestions", () => {
  const plan = (id: string, title: string) =>
    ({ id, title, status: "draft", created: "2026-01-01" }) as unknown as PlanSummary;
  function withPlans(plans: PlanSummary[]) {
    const { effects } = setup();
    const actions = createCommandActions({
      pid: "alpha",
      projects: [project("alpha")],
      tasks: [],
      plans,
      epics: [],
      currentTask: null,
      runnerEnabled: true,
      settingsLoaded: true,
      effects: { ...effects, openNewPlan: vi.fn() },
    });
    return { actions, effects };
  }

  it("lists every verb in the unknown hint", () => {
    const text = formatConsoleResult({ kind: "unknown", input: "x" });
    for (const v of CONSOLE_VERBS) expect(text).toContain(`/${v}`);
    for (const v of ["activate", "project", "runner", "theme", "new", "plan"])
      expect(text).toContain(`/${v}`);
  });

  it("understands every verb in the table", () => {
    const { actions } = setup();
    for (const v of CONSOLE_VERBS) {
      const r = resolveConsoleCommand(`/${v}`, actions);
      expect(r.kind === "unknown" ? r.reason : "").not.toBe("no such command");
    }
  });

  it("/plan runs the new-plan action with its title", () => {
    const { actions } = withPlans([]);
    const r = resolveConsoleCommand("/plan Launch site", actions);
    expect(r).toMatchObject({ kind: "run", args: "Launch site" });
    expect(r.kind === "run" && r.action.id).toBe("new-plan");
  });

  it("/plan opens Plans when nothing provides the wizard", () => {
    const { actions, effects } = setup();
    const r = resolveConsoleCommand("/plan", actions);
    if (r.kind === "run") void r.action.run(r.args);
    expect(effects.navigate).toHaveBeenCalledWith({ name: "plans", pid: "alpha" });
  });

  it("labels the activation action 'Create tasks from plan' and keeps /activate", () => {
    const { actions } = withPlans([plan("p1", "Launch")]);
    const a = actions.find((x) => x.id === "activate-plan-p1")!;
    expect(a.label).toBe("Create tasks from plan: Launch");
    expect(a.keywords).toEqual(expect.arrayContaining(["activate", "plan", "tasks"]));
    expect(idOf(resolveConsoleCommand("/activate launch", actions))).toBe("activate-plan-p1");
  });

  it("the owner's sentence suggests /activate and runs nothing", () => {
    const { actions, effects } = withPlans([plan("p1", "Launch")]);
    const r = resolveConsoleCommand("Make tasks out of the plans", actions);
    expect(r).toEqual({
      kind: "suggest",
      input: "Make tasks out of the plans",
      lines: ["Did you mean: /activate Launch? Press Enter to run it."],
      prefill: "/activate Launch",
    });
    expect(effects.activatePlan).not.toHaveBeenCalled();
  });

  it.each([
    "make the plan into tasks",
    "create tasks from the plan",
    "turn the plans into tasks",
    "generate plan into tasks",
    "tasks out of plans",
    "tasks from the plan.",
  ])("suggests for %s", (text) => {
    const { actions } = withPlans([plan("p1", "Launch")]);
    expect(resolveConsoleCommand(text, actions)).toMatchObject({ kind: "suggest" });
  });

  it("lists up to five draft plans and prefills /activate", () => {
    const { actions } = withPlans(Array.from({ length: 7 }, (_, i) => plan(`p${i}`, `Plan ${i}`)));
    const r = resolveConsoleCommand("make tasks out of the plans", actions);
    expect(r.kind === "suggest" && r.prefill).toBe("/activate ");
    const lines = r.kind === "suggest" ? r.lines : [];
    expect(lines.filter((l) => l.startsWith("  Plan "))).toHaveLength(5);
    expect(lines.join("\n")).toContain("and 2 more");
  });

  it("with no draft plan points to /plan", () => {
    const { actions } = withPlans([]);
    expect(resolveConsoleCommand("make tasks out of the plans", actions)).toEqual({
      kind: "suggest",
      input: "make tasks out of the plans",
      lines: ["No draft plan. Type /plan to write one."],
      prefill: null,
    });
  });

  it("suggests runner and plan commands without running them", () => {
    const { actions, effects } = withPlans([]);
    expect(resolveConsoleCommand("pause everything", actions)).toMatchObject({
      kind: "suggest",
      prefill: "/runner pause",
    });
    expect(resolveConsoleCommand("create a plan", actions)).toMatchObject({ prefill: "/plan" });
    expect(resolveConsoleCommand("what is running", actions)).toMatchObject({
      prefill: "/go overview",
    });
    expect(effects.setRunner).not.toHaveBeenCalled();
  });

  it("does not suggest starting a runner that already runs", () => {
    const { actions } = withPlans([]);
    expect(resolveConsoleCommand("start the runner", actions)).toMatchObject({
      kind: "suggest",
      prefill: null,
    });
  });

  it("never runs a write from plain words", () => {
    const { actions } = withPlans([plan("p1", "Launch")]);
    for (const text of ["make tasks out of the plans", "pause everything", "create a plan"]) {
      expect(resolveConsoleCommand(text, actions).kind).toBe("suggest");
    }
  });
});
