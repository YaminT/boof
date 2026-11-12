import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSettings,
  effectiveSettings,
  newTask,
  ProjectStore,
  TaskStore,
  type OrchestrationProfile,
  type Settings,
} from "@boof/heart";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pipeline, type PipelineOutcome } from "./pipeline.js";
import { MockTool, mockState } from "./tools/mock.js";
import { ToolRegistry } from "./tools/registry.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  mockState.calls = [];
  mockState.prompts = [];
  mockState.onRun = null;
  mockState.roleQuestions = {};
});
beforeEach(() => {
  mockState.calls = [];
  mockState.prompts = [];
});

const on = { tool: "mock", model: "mock-default" };

function profile(id: string, roles: Partial<OrchestrationProfile["roles"]>): OrchestrationProfile {
  return {
    id,
    name: `Profile ${id}`,
    roles: {
      planner: on,
      developer: on,
      observer: null,
      reviewer: on,
      ...roles,
    },
  };
}

async function run(
  profiles: OrchestrationProfile[],
  active: string | null,
  beforeRun?: (settings: Settings) => void,
): Promise<{ outcome: PipelineOutcome; settings: Settings }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "boof-roles-data-"));
  const workDir = await mkdtemp(join(tmpdir(), "boof-roles-work-"));
  roots.push(dataRoot, workDir);
  const settings: Settings = {
    ...defaultSettings(),
    runner: { ...defaultSettings().runner, enabled: true, concurrency: 1 },
    roles: { planner: on, developer: on, reviewer: on },
    defaultProject: "roles-test",
    ...(profiles.length > 0 ? { profiles } : {}),
    ...(active ? { activeProfile: active } : {}),
  };
  const project = await new ProjectStore(dataRoot).create({
    workingDirectory: workDir,
    id: "roles-test",
  });
  const projectDir = new ProjectStore(dataRoot).dir(project.id);
  const store = new TaskStore(projectDir);
  const task = newTask(
    {
      id: "roles-task",
      title: "Roles",
      status: "pending",
      priority: 50,
      skip: false,
      labels: [],
      command: null,
      attachments: [],
      questions: "none",
      created: new Date(0).toISOString(),
      updated: new Date(0).toISOString(),
    },
    "Do the thing.",
  );
  await store.create(task);
  const running = await store.transition("roles-task", "running");
  const effective = effectiveSettings(settings, project);
  beforeRun?.(effective);
  const outcome = await new Pipeline({
    root: projectDir,
    dataRoot,
    project,
    store,
    registry: new ToolRegistry([new MockTool()]),
    settings: effective,
  }).run(running);
  return { outcome, settings: effective };
}

describe("pipeline roles off", () => {
  it("all roles on: planner, refinement, developer, reviewer (unchanged)", async () => {
    const { outcome } = await run([profile("full", {})], "full");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "reviewer"]);
    if (outcome.kind === "done") {
      expect(outcome.task.body.log).toContain(
        "profile Profile full: planner mock mock-default, developer mock mock-default, observer off, reviewer mock mock-default",
      );
    }
  });

  it("no profiles: behaves as before and logs no profile line", async () => {
    const { outcome } = await run([], null);
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "reviewer"]);
    if (outcome.kind === "done") expect(outcome.task.body.log).not.toContain("profile ");
  });

  it("planner off: no planner step, the developer works from the task", async () => {
    const { outcome } = await run([profile("nop", { planner: null })], "nop");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["developer", "reviewer"]);
    expect(mockState.prompts[0]).toContain("Do the thing.");
    expect(mockState.prompts[0]).toContain("The planner is off");
    if (outcome.kind === "done") {
      expect(outcome.task.body.log).toContain("planner off, developer mock mock-default");
    }
  });

  it("reviewer and observer off: the task ends done, marked not reviewed", async () => {
    const { outcome } = await run([profile("norev", { reviewer: null })], "norev");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer"]);
    if (outcome.kind === "done") {
      expect(outcome.task.body.log).toContain("Not reviewed (profile Profile norev)");
    }
  });

  it("developer only: just the developer runs", async () => {
    const { outcome } = await run([profile("solo", { planner: null, reviewer: null })], "solo");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["developer"]);
  });

  it("observer on and reviewer off: the observer still reviews", async () => {
    const { outcome } = await run([profile("obs", { observer: on, reviewer: null })], "obs");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "observer"]);
  });

  it("roles are a snapshot: a profile switch mid-run does not change this task", async () => {
    const other = profile("other", { reviewer: null });
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") {
        // The settings change while the developer runs.
        current!.activeProfile = "other";
      }
    };
    let current: Settings | undefined;
    const { outcome } = await run([profile("first", {}), other], "first", (s) => {
      current = s;
    });
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "reviewer"]);
  });

  it("developer question with the planner off parks the task for the owner", async () => {
    mockState.roleQuestions = { developer: ["Which database?"] };
    const { outcome } = await run([profile("nop", { planner: null })], "nop");
    expect(outcome.kind).toBe("parked");
    if (outcome.kind === "parked") {
      expect(outcome.questions.join("\n")).toContain("Which database?");
    }
    expect(mockState.calls).toEqual(["developer"]);
  });
});
