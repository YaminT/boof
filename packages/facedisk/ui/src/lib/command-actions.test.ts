import { describe, expect, it, vi } from "vitest";
import type { Project } from "@boof/heart/schema";
import type { EpicView, PlanSummary, TaskView } from "../api.js";
import { createCommandActions, type ActionContext, type ActionEffects } from "./command-actions.js";

const task = (id: string, status: string, origin?: string, title = id): TaskView =>
  ({
    projectId: "alpha",
    frontmatter: {
      id,
      title,
      status,
      origin: origin ? { kind: origin } : undefined,
      created: "2026-01-01",
    },
    body: {},
  }) as unknown as TaskView;
const project = (id: string, name = id, archived = false) =>
  ({ id, name, archived }) as unknown as Project;
const plan = (id: string, status = "draft") =>
  ({ id, title: `Plan ${id}`, status, created: "2026-01-01" }) as unknown as PlanSummary;

function effects(): ActionEffects {
  return {
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
}
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  pid: "alpha",
  projects: [project("alpha"), project("beta"), project("old", "Old", true)],
  tasks: [task("t1", "draft"), task("t2", "running"), task("t3", "done")],
  plans: [plan("p1"), plan("p2", "active")],
  epics: [],
  currentTask: null,
  runnerEnabled: false,
  settingsLoaded: true,
  effects: effects(),
  ...over,
});
const ids = (c: ActionContext) => createCommandActions(c).map((a) => a.id);

describe("createCommandActions", () => {
  it("gives every action a stable id", () => {
    expect(ids(ctx())).toEqual([
      "go-inbox",
      "go-overview",
      "go-tasks",
      "go-plans",
      "go-settings-project",
      "go-settings-agents",
      "go-settings-budgets",
      "go-settings-keys",
      "go-settings-automation",
      "switch-project-alpha",
      "switch-project-beta",
      "open-task-t1",
      "open-task-t2",
      "open-task-t3",
      "new-task",
      "new-plan",
      "activate-plan-p1",
      "queue-t1",
      "stop-t2",
      "new-epic",
      "assistant.new",
      "toggle-runner",
      "theme-light",
      "theme-dark",
      "theme-system",
    ]);
    expect(ids(ctx())).toEqual(ids(ctx()));
  });

  it("offers only what the context allows", () => {
    const none = ids(ctx({ pid: null, tasks: [], plans: [] }));
    expect(none).toEqual([
      "go-inbox",
      "switch-project-alpha",
      "switch-project-beta",
      "toggle-runner",
      "theme-light",
      "theme-dark",
      "theme-system",
    ]);
    expect(ids(ctx({ tasks: [task("t3", "done")], plans: [plan("p2", "active")] }))).not.toContain(
      "queue-t3",
    );
    expect(ids(ctx({ tasks: [], plans: [plan("p2", "active")] }))).not.toContain(
      "activate-plan-p2",
    );
  });

  it("labels the runner action by what it does now, and disables it until settings load", () => {
    const on = createCommandActions(ctx({ runnerEnabled: true })).find(
      (a) => a.id === "toggle-runner",
    )!;
    expect(on.label).toBe("Pause the runner");
    const loading = createCommandActions(ctx({ settingsLoaded: false })).find(
      (a) => a.id === "toggle-runner",
    )!;
    expect(loading.disabled).toBe(true);
  });

  it("marks proposed drafts and the current project", () => {
    const actions = createCommandActions(ctx({ tasks: [task("t1", "draft", "api")] }));
    expect(actions.find((a) => a.id === "queue-t1")!.label).toBe("Queue proposed task: t1");
    expect(actions.find((a) => a.id === "switch-project-alpha")!.meta).toBe("current");
    expect(actions.find((a) => a.id === "switch-project-beta")!.meta).toBeUndefined();
  });

  it("runs the supplied effect exactly once, with the right arguments", async () => {
    const c = ctx();
    const get = (id: string) => createCommandActions(c).find((a) => a.id === id)!;
    await get("go-tasks").run();
    expect(c.effects.navigate).toHaveBeenCalledExactlyOnceWith({ name: "tasks", pid: "alpha" });
    await get("queue-t1").run();
    expect(c.effects.queueTask).toHaveBeenCalledExactlyOnceWith("alpha", "t1");
    await get("activate-plan-p1").run();
    expect(c.effects.activatePlan).toHaveBeenCalledOnce();
    await get("stop-t2").run();
    expect(c.effects.requestStop).toHaveBeenCalledOnce();
    await get("switch-project-beta").run();
    expect(c.effects.selectProject).toHaveBeenCalledExactlyOnceWith("beta");
    await get("theme-dark").run();
    expect(c.effects.setTheme).toHaveBeenCalledExactlyOnceWith("dark");
    await get("toggle-runner").run();
    expect(c.effects.setRunner).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("names the scope an action needs", () => {
    const by = Object.fromEntries(createCommandActions(ctx()).map((a) => [a.id, a.requiredScope]));
    expect(by["queue-t1"]).toBe("tasks:write");
    expect(by["stop-t2"]).toBe("tasks:control");
    expect(by["go-tasks"]).toBeUndefined();
    expect(by["assistant.new"]).toBe("tasks:read");
  });

  it("offers a new assistant conversation that resets this project's assistant", async () => {
    const c = ctx();
    const action = createCommandActions(c).find((a) => a.id === "assistant.new")!;
    expect(action.label).toBe("New assistant conversation");
    expect(action.keywords).toEqual(["/new", "assistant", "reset"]);
    await action.run();
    expect(c.effects.resetAssistant).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(createCommandActions(ctx({ pid: null })).some((a) => a.id === "assistant.new")).toBe(
      false,
    );
  });
});

const epic = (id: string, o: Partial<EpicView> = {}) =>
  ({ id, title: `E ${id}`, archived: false, priority: 0, ...o }) as unknown as EpicView;

describe("hierarchy actions", () => {
  const top = (id: string, extra: Record<string, unknown> = {}, view: Partial<TaskView> = {}) =>
    ({
      projectId: "alpha",
      frontmatter: { id, title: `T ${id}`, status: "draft", ...extra },
      body: {},
      ...view,
    }) as unknown as TaskView;
  const all = [
    top("a"),
    top("b"),
    top("kid", { parentId: "a" }),
    top("old", { status: "archived" }),
  ];
  const withTask = (current: TaskView, over: Partial<ActionContext> = {}) =>
    ctx({
      tasks: all,
      epics: [epic("e1"), epic("e2", { archived: true })],
      currentTask: current,
      ...over,
    });

  it("offers New epic with a project, and nothing task-specific without a current task", () => {
    expect(ids(ctx())).toContain("new-epic");
    expect(ids(ctx({ pid: null, tasks: [], plans: [] }))).not.toContain("new-epic");
    const plain = ids(ctx({ epics: [epic("e1")] }));
    expect(plain.filter((i) => /^(move-epic|make-subtask|detach)/.test(i))).toEqual([]);
  });

  it("offers a top-level task a move to each live epic and a parent among the other top-level tasks", () => {
    const got = ids(withTask(all[0]!));
    expect(got).toContain("move-epic-e1");
    expect(got).not.toContain("move-epic-e2"); // archived
    expect(got).toContain("make-subtask-b");
    expect(got).not.toContain("make-subtask-a"); // itself
    expect(got).not.toContain("make-subtask-kid"); // a subtask cannot be a parent
    expect(got).not.toContain("make-subtask-old"); // archived
    expect(got).not.toContain("detach-parent");
    expect(got).not.toContain("detach-epic");
  });

  it("does not offer a task with subtasks as a subtask, and leaves a subtask's epic to its parent", () => {
    const parent = top("a", {}, { subtasks: { total: 1, done: 0 } });
    expect(ids(withTask(parent)).some((i) => i.startsWith("make-subtask-"))).toBe(false);
    const kid = all[2]!;
    const got = ids(withTask(kid));
    expect(got).toContain("detach-parent");
    expect(got.some((i) => i.startsWith("move-epic-"))).toBe(false);
    expect(got.some((i) => i.startsWith("make-subtask-"))).toBe(false);
  });

  it("offers Detach from epic only for the task's own epic", () => {
    const own = top("a", { epicId: "e1" }, { epicId: "e1" });
    const got = ids(withTask(own));
    expect(got).toContain("detach-epic");
    expect(got).not.toContain("move-epic-e1"); // already there
    expect(ids(withTask(top("a", {}, { epicId: "e1" })))).not.toContain("detach-epic");
  });

  it("sends the right payload to the effects, once", async () => {
    const c = withTask(all[0]!);
    const get = (id: string) => createCommandActions(c).find((a) => a.id === id)!;
    await get("move-epic-e1").run();
    expect(c.effects.moveTask).toHaveBeenLastCalledWith("alpha", "a", { epicId: "e1" });
    await get("make-subtask-b").run();
    expect(c.effects.moveTask).toHaveBeenLastCalledWith("alpha", "a", { parentId: "b" });
    expect(c.effects.moveTask).toHaveBeenCalledTimes(2);
    const k = withTask(all[2]!);
    await createCommandActions(k)
      .find((a) => a.id === "detach-parent")!
      .run();
    expect(k.effects.moveTask).toHaveBeenCalledExactlyOnceWith("alpha", "kid", { parentId: null });
    const o = withTask(top("a", { epicId: "e1" }, { epicId: "e1" }));
    await createCommandActions(o)
      .find((a) => a.id === "detach-epic")!
      .run();
    expect(o.effects.moveTask).toHaveBeenCalledExactlyOnceWith("alpha", "a", { epicId: null });
  });

  it("New epic creates one from the typed name, or opens the sheet without one", async () => {
    const c = ctx();
    const a = createCommandActions(c).find((x) => x.id === "new-epic")!;
    await a.run("  Payments  ");
    expect(c.effects.createEpic).toHaveBeenCalledExactlyOnceWith("alpha", "Payments");
    await a.run();
    await a.run("   ");
    expect(c.effects.openNewEpic).toHaveBeenCalledTimes(2);
    expect(c.effects.createEpic).toHaveBeenCalledTimes(1);
  });

  it("needs tasks:write for all of them", () => {
    const by = Object.fromEntries(
      createCommandActions(withTask(all[0]!)).map((a) => [a.id, a.requiredScope]),
    );
    expect(by["new-epic"]).toBe("tasks:write");
    expect(by["move-epic-e1"]).toBe("tasks:write");
    expect(by["make-subtask-b"]).toBe("tasks:write");
  });
});
