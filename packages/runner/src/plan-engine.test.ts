import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentStatus,
  defaultSettings,
  newTask,
  parseGoal,
  PlanStore,
  ProjectStore,
  SettingsStore,
  TaskStore,
  testGoal,
  type Project,
  type TaskFrontmatter,
} from "@boof-runner/shared";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { mockState, resetMock } from "./tools/mock.js";

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;
let project: Project;
let projectDir: string;
let store: TaskStore;
let plans: PlanStore;

const mock = { tool: "mock", model: "mock-default" };

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "pt",
  title: "PT",
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  tools: { planner: mock, developer: mock, reviewer: mock },
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-planeng-data-"));
  workDir = await realpath(await mkdtemp(join(tmpdir(), "boof-planeng-work-")));
  const g = (args: string[]) => execCommand("git", args, { cwd: workDir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(workDir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);

  const defaults = defaultSettings();
  await new SettingsStore(dataRoot).save({
    ...defaults,
    runner: { enabled: true, concurrency: 1 },
    defaultProject: "default",
    // Tasks created by plan sync carry no tool override: run them on the mock tool too.
    roles: { planner: mock, developer: mock, reviewer: mock },
  });
  project = await new ProjectStore(dataRoot).create({ workingDirectory: workDir, id: "default" });
  projectDir = new ProjectStore(dataRoot).dir(project.id);
  store = new TaskStore(projectDir);
  plans = new PlanStore(projectDir);
  engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
  resetMock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  resetMock();
});

const goalXml = (text: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>${text}</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;

async function makePlan(over: Record<string, unknown> = {}) {
  return plans.create({
    id: "p",
    title: "P",
    status: "active",
    source: { kind: "api" },
    goals: [testGoal("core", 1, [], { path: "core", taskId: "pt" })],
    ...over,
  });
}

async function planTask(planId: string, goalId: string, id = "pt"): Promise<void> {
  await store.create(
    newTask(
      fm({ id, planRef: { planId, goalId, revision: 1 }, labels: [`plan:${planId}`] }),
      "Implement core.",
    ),
  );
}

async function writeRepoGoal(): Promise<void> {
  await mkdir(join(workDir, "core"), { recursive: true });
  await writeFile(join(workDir, "core", "goal.boof.xml"), goalXml("Build the core."), "utf8");
}

describe("plan tasks finishing (mock tool)", () => {
  it("records the goal status in the plan history and writes it back to the repo XML", async () => {
    await writeRepoGoal();
    await makePlan();
    await planTask("p", "core");

    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("done");

    const plan = await plans.require("p");
    const goal = plan.goals[0]!;
    expect(goal.status).toBe("done");
    expect(goal.taskId).toBeNull();
    expect(goal.history.at(-1)).toMatchObject({
      revision: 1,
      status: "done",
      description: "boof-runner completed task pt",
      taskId: "pt",
    });
    expect(plan.version).toBe(2);

    const xml = parseGoal(await readFile(join(workDir, "core", "goal.boof.xml"), "utf8"));
    expect(currentStatus(xml)).toBe("done");
    expect(xml.progress.versions).toHaveLength(2);
  });

  it("honours plan.bumpTo and leaves the repo alone when planWriteBack is off", async () => {
    await writeRepoGoal();
    const original = await readFile(join(workDir, "core", "goal.boof.xml"), "utf8");
    await new ProjectStore(dataRoot).update("default", { planWriteBack: false });
    await makePlan({ bumpTo: "review" });
    await planTask("p", "core");

    await engine.tick();
    expect((await plans.require("p")).goals[0]!.status).toBe("review");
    expect(await readFile(join(workDir, "core", "goal.boof.xml"), "utf8")).toBe(original);
  });

  it("only records history for a revision-1 task when the goal moved on (sync reopens it later)", async () => {
    await makePlan({ goals: [testGoal("core", 1, [], { taskId: "pt", revision: 3 })] });
    await planTask("p", "core");
    await engine.tick();
    const goal = (await plans.require("p")).goals[0]!;
    expect(goal.history.at(-2)).toMatchObject({ revision: 1, status: "done" });
    expect(goal.history.at(-1)).toMatchObject({ revision: 3, status: "develop" });
    expect(goal.status).toBe("develop");
    expect(goal.revision).toBe(3);
  });

  it("still finishes when the goal has no path or the plan is gone", async () => {
    await makePlan({ goals: [testGoal("core", 1, [], { taskId: "pt" })] });
    await planTask("p", "core");
    await planTask("missing-plan", "core", "pt2");
    const run = await engine.runUntilIdle();
    expect(run.filter((x) => x.kind === "ran")).toHaveLength(2);
    expect((await store.get("pt"))?.frontmatter.status).toBe("done");
    expect((await store.get("pt2"))?.frontmatter.status).toBe("done");
    expect((await plans.require("p")).goals[0]!.status).toBe("done");
  });

  it("does not write outside the repo for a goal path that escapes it", async () => {
    await makePlan();
    // Bypass the schema guard by editing the stored file directly.
    const file = join(projectDir, "plans", "p.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.goals[0].path = "../outside";
    await writeFile(file, JSON.stringify(raw), "utf8");
    await planTask("p", "core");
    // The tampered file no longer parses, so the plan write is skipped, and the task still ends done.
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("done");
    expect((await store.get("pt"))?.frontmatter.status).toBe("done");
  });

  it("legacy boofGoal tasks keep their old behaviour and do not touch plans", async () => {
    await writeRepoGoal();
    await makePlan();
    await store.create(
      newTask(
        fm({ id: "legacy", boofGoal: { path: "core/goal.boof.xml", bumpTo: "done" } }),
        "Implement core.",
      ),
    );
    await engine.tick();
    expect((await plans.require("p")).version).toBe(1);
    expect(
      currentStatus(parseGoal(await readFile(join(workDir, "core", "goal.boof.xml"), "utf8"))),
    ).toBe("done");
  });
});

describe("goal.tasks (mock tool)", () => {
  it("records the finished task", async () => {
    await makePlan();
    await plans.modify("p", (p) => ({
      ...p,
      goals: p.goals.map((g) => ({
        ...g,
        tasks: [
          { taskId: "pt", revision: 1, status: "pending" as const, branch: "boof-runner/pt" },
        ],
      })),
    }));
    await planTask("p", "core");
    await engine.tick();
    const goal = (await plans.require("p")).goals[0]!;
    expect(goal.tasks).toEqual([
      { taskId: "pt", revision: 1, status: "done", branch: "boof-runner/pt" },
    ]);
  });

  it("records failed and action statuses", async () => {
    const entry = {
      taskId: "pt",
      revision: 1,
      status: "pending" as const,
      branch: "boof-runner/pt",
    };
    await makePlan({ goals: [testGoal("core", 1, [], { taskId: "pt", tasks: [entry] })] });
    await planTask("p", "core");
    mockState.plannerQuestions = ["Which database?"];
    await engine.tick();
    expect((await plans.require("p")).goals[0]!.tasks[0]!.status).toBe("action");
    resetMock();
    await store.transition("pt", "pending");
    mockState.failRole = "developer";
    await engine.tick();
    expect((await store.get("pt"))!.frontmatter.status).toBe("failed");
    expect((await plans.require("p")).goals[0]!.tasks[0]!.status).toBe("failed");
  });

  it("an unblocked goal gets its task without a manual sync (autoSync)", async () => {
    await plans.create({
      id: "auto",
      title: "Auto",
      status: "active",
      autoSync: true,
      source: { kind: "api" },
      goals: [testGoal("a", 1), testGoal("b", 2, ["a"])],
    });
    // Run only one task: `a`. Then `b` must be created by the engine's own sync.
    await engine.tick();
    expect((await store.list()).map((t) => t.frontmatter.id)).toEqual(["boof-a"]);
    await engine.syncAutoPlans();
    const ids = (await store.list()).map((t) => t.frontmatter.id).sort();
    expect(ids).toEqual(["boof-a", "boof-b"]);
    const b = (await plans.require("auto")).goals[1]!;
    expect(b.taskId).toBe("boof-b");
    expect(b.tasks.map((t) => t.taskId)).toEqual(["boof-b"]);
  });
});

describe("autoSync (mock tool)", () => {
  it("syncs active autoSync plans: dependent goals run after their dependencies", async () => {
    await plans.create({
      id: "auto",
      title: "Auto",
      status: "active",
      autoSync: true,
      source: { kind: "api" },
      goals: [testGoal("a", 1), testGoal("b", 2, ["a"])],
    });
    const results = await engine.runUntilIdle();
    expect(results.filter((r) => r.kind === "ran")).toHaveLength(2);
    expect((await plans.require("auto")).goals.map((g) => g.status)).toEqual(["done", "done"]);
    const states = (await store.list()).map((t) => [t.frontmatter.id, t.frontmatter.status]);
    expect(states.sort()).toEqual([
      ["boof-a", "done"],
      ["boof-b", "done"],
    ]);
  });

  it("does not sync a plan without autoSync, nor a draft one", async () => {
    await plans.create({
      id: "manual",
      title: "M",
      status: "active",
      source: { kind: "api" },
      goals: [testGoal("a", 1)],
    });
    await plans.create({
      id: "drafty",
      title: "D",
      autoSync: true,
      source: { kind: "api" },
      goals: [testGoal("z", 1)],
    });
    expect((await engine.runUntilIdle()).map((r) => r.kind)).toEqual(["idle"]);
    expect(await store.list()).toEqual([]);
  });

  it("a failing sync is logged and never stops the queue", async () => {
    await plans.create({
      id: "auto",
      title: "Auto",
      status: "active",
      autoSync: true,
      source: { kind: "api" },
      goals: [testGoal("a", 1)],
    });
    // Task creation fails: the pending directory is a file.
    await rm(join(projectDir, "tasks", "pending"), { recursive: true, force: true });
    await writeFile(join(projectDir, "tasks", "pending"), "not a directory", "utf8");
    const seen: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void seen.push(args);
    try {
      await store.create(newTask(fm({ id: "normal", status: "draft" }), "x"));
      const r = await engine.tick();
      expect(r.kind).toBe("idle");
    } finally {
      console.error = orig;
    }
    expect(seen.some((a) => String(a[0]).includes("plan sync failed"))).toBe(true);
  });
});
