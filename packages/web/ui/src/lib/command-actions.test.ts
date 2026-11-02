import { describe, expect, it, vi } from "vitest";
import type { Project } from "@boof-runner/shared/schema";
import type { PlanSummary, TaskView } from "../api.js";
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
  };
}
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  pid: "alpha",
  projects: [project("alpha"), project("beta"), project("old", "Old", true)],
  tasks: [task("t1", "draft"), task("t2", "running"), task("t3", "done")],
  plans: [plan("p1"), plan("p2", "active")],
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
      "activate-plan-p1",
      "queue-t1",
      "stop-t2",
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
  });
});
