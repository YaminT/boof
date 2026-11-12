import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSettings,
  effectiveSettings,
  newTask,
  PlanStore,
  ProjectStore,
  TaskStore,
  type Settings,
} from "@boof/heart";
import { afterEach, describe, expect, it } from "vitest";
import { Pipeline, type PipelineOutcome } from "./pipeline.js";
import { MockTool, mockState } from "./tools/mock.js";
import { formatQuestions, withQuestions } from "./tools/questions.js";
import type { RunOptions, RunResult } from "./tools/types.js";
import { ToolRegistry } from "./tools/registry.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  mockState.calls = [];
  mockState.prompts = [];
  mockState.systemPrompts = [];
});

const GOALS = {
  goals: [
    { id: "one", title: "One", details: "First", dependsOn: [] },
    { id: "two", title: "Two", details: "", dependsOn: ["one"] },
  ],
};

/** A mock whose planner reports what the test scripts. */
class ScriptedPlanner extends MockTool {
  constructor(private readonly script: (opts: RunOptions) => Partial<RunResult>) {
    super();
  }
  override async run(opts: RunOptions): Promise<RunResult> {
    const base = await super.run(opts);
    return { ...base, ...this.script(opts) };
  }
}

const fenced = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

async function run(
  script: (opts: RunOptions) => Partial<RunResult>,
  opts: { planVersion?: number } = {},
): Promise<{ outcome: PipelineOutcome; planStore: PlanStore }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "boof-draft-data-"));
  const workDir = await mkdtemp(join(tmpdir(), "boof-draft-work-"));
  roots.push(dataRoot, workDir);
  const settings: Settings = {
    ...defaultSettings(),
    runner: { ...defaultSettings().runner, enabled: true, concurrency: 1 },
    roles: {
      planner: { tool: "mock", model: "mock-default" },
      developer: { tool: "mock", model: "mock-default" },
      reviewer: { tool: "mock", model: "mock-default" },
    },
    defaultProject: "draft-test",
  };
  const project = await new ProjectStore(dataRoot).create({
    workingDirectory: workDir,
    id: "draft-test",
  });
  const projectDir = new ProjectStore(dataRoot).dir(project.id);
  const planStore = new PlanStore(projectDir);
  await planStore.create({ id: "the-plan", title: "The plan", source: { kind: "ui" } });
  const store = new TaskStore(projectDir);
  await store.create(
    newTask(
      {
        id: "draft-task",
        title: "Draft tasks: The plan",
        status: "pending",
        priority: 50,
        skip: false,
        labels: ["plan-draft"],
        command: null,
        attachments: [],
        questions: "none",
        promptSource: "manual",
        draftFor: { planId: "the-plan", planVersion: opts.planVersion ?? 1 },
        created: new Date(0).toISOString(),
        updated: new Date(0).toISOString(),
      },
      "## Request\nBuild a thing.",
    ),
  );
  const running = await store.transition("draft-task", "running");
  const outcome = await new Pipeline({
    root: projectDir,
    dataRoot,
    project,
    store,
    registry: new ToolRegistry([new ScriptedPlanner(script)]),
    settings: effectiveSettings(settings, project),
  }).run(running);
  return { outcome, planStore };
}

describe("plan-draft task", () => {
  it("runs one planner step, replaces the plan's goals and skips developer and review", async () => {
    const { outcome, planStore } = await run(() => ({ report: fenced(GOALS) }));
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner"]);
    expect(mockState.systemPrompts[0]!.systemPrompt).toContain("drafting the task list");
    const plan = await planStore.require("the-plan");
    expect(plan.goals.map((g) => g.id)).toEqual(["one", "two"]);
    expect(plan.goals[1]!.dependsOn).toEqual(["one"]);
    expect(plan.status).toBe("draft");
    if (outcome.kind === "done") {
      expect(outcome.task.body.log).toContain("now has 2 goal(s)");
    }
  });

  it("keeps the plan and says so when it changed while drafting", async () => {
    const { outcome, planStore } = await run(() => ({ report: fenced(GOALS) }), {
      planVersion: 7,
    });
    expect(outcome.kind).toBe("done");
    expect((await planStore.require("the-plan")).goals).toEqual([]);
    if (outcome.kind === "done") {
      expect(outcome.task.body.log).toContain(
        "The plan changed while drafting; nothing was replaced",
      );
    }
  });

  it("fails with a clear message on junk and leaves the plan alone", async () => {
    const { outcome, planStore } = await run(() => ({ report: "I wrote no json." }));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error).toContain("plan draft:");
    expect((await planStore.require("the-plan")).goals).toEqual([]);
  });

  it("parks the task when the agent asks a question", async () => {
    const asked = withQuestions({
      output: "asked",
      report: `Need input.\n\n${formatQuestions(["Which database?"])}`,
    });
    const { outcome, planStore } = await run(() => asked);
    expect(outcome.kind).toBe("parked");
    if (outcome.kind === "parked") expect(outcome.questions).toEqual(["Which database?"]);
    expect((await planStore.require("the-plan")).goals).toEqual([]);
  });
});
