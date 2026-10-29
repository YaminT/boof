import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dayKey,
  defaultSettings,
  newTask,
  ProjectStore,
  readDailyLedger,
  readEvents,
  SettingsStore,
  TaskStore,
  budgetTimeZone,
  type BudgetSettings,
  type Project,
  type TaskFrontmatter,
} from "@boof-runner/shared";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { mockState, resetMock } from "./tools/mock.js";

let dataRoot: string;
const dirs: string[] = [];
let engine: RunnerEngine;
let projects: ProjectStore;
let settings: SettingsStore;

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "boof-budget-work-")));
  dirs.push(dir);
  const g = (args: string[]) => execCommand("git", args, { cwd: dir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(dir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
  return dir;
}

const fm = (id: string, over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id,
  title: id,
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  tools: {
    planner: { tool: "mock", model: "mock-default" },
    developer: { tool: "mock", model: "mock-default" },
    reviewer: { tool: "mock", model: "mock-default" },
  },
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

const useBudget = (budget: Partial<BudgetSettings>) =>
  settings.update({ budget: { onExceed: "pause", ...budget } });
const tasksOf = (p: Project) => new TaskStore(projects.dir(p.id));
/** A task whose every mock step costs `cost` (4 steps in a clean run). */
const addTask = (p: Project, id: string, cost: string | number = 0.5, over = {}) =>
  tasksOf(p).create(newTask(fm(id, over), `Work. [[mock-cost ${cost}]]`));
const budgetEvents = async () =>
  (await readEvents(dataRoot, null))
    .map((e) => e.event)
    .filter((e) => e.type === "runner.budget_exceeded");

let main: Project;
beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-budget-data-"));
  settings = new SettingsStore(dataRoot);
  await settings.save({ ...defaultSettings(), runner: { enabled: true, concurrency: 1 } });
  projects = new ProjectStore(dataRoot);
  main = await projects.create({ workingDirectory: await repo(), id: "main" });
  engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
  resetMock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

describe("daily ledger", () => {
  it("records every step per day, project and tool even with no budget set", async () => {
    await addTask(main, "t1");
    await engine.runUntilIdle();
    const tz = budgetTimeZone({});
    const day = dayKey(new Date(), tz);
    const global = await readDailyLedger(dataRoot, day, tz);
    expect(global.costUsd).toBeCloseTo(2);
    expect(global.tools).toEqual({ mock: expect.closeTo(2) });
    expect(global.projects).toEqual({ main: expect.closeTo(2) });
    expect((await readDailyLedger(projects.dir("main"), day, tz)).costUsd).toBeCloseTo(2);
    expect((await tasksOf(main).get("t1"))?.frontmatter.status).toBe("done");
  });

  it("counts steps with unknown usage as 0 and flags them", async () => {
    await addTask(main, "t1", "unknown");
    await useBudget({ perDayUsd: 0.01 });
    await engine.runUntilIdle();
    const tz = budgetTimeZone({});
    const day = await readDailyLedger(dataRoot, dayKey(new Date(), tz), tz);
    expect(day.costUsd).toBe(0);
    expect(day.unknownSteps).toBe(4);
    expect((await tasksOf(main).get("t1"))?.frontmatter.status).toBe("done");
  });
});

describe("per-task limit", () => {
  it("fails the task between steps, never mid-step, and keeps the worktree on pause", async () => {
    await settings.update({ worktree: { onDone: "keep-branch", onFailure: "delete" } });
    await useBudget({ perTaskUsd: 1.2, onExceed: "pause" });
    await addTask(main, "t1");
    const results = await engine.runUntilIdle();
    const t = await tasksOf(main).get("t1");
    expect(t?.frontmatter.status).toBe("failed");
    // planner, refinement and developer ran (1.50 spent); the 4th step never started.
    expect(mockState.calls).toEqual(["planner", "planner", "developer"]);
    expect(t?.body.log).toContain("budget exceeded: task:t1 1.5000/1.2 USD");
    expect(existsSync(join(main.workingDirectory, ".boof-runner-worktrees", "t1"))).toBe(true);
    expect(results.at(-1)).toEqual({ kind: "idle" });
  });

  it("with onExceed fail follows worktree.onFailure", async () => {
    await settings.update({ worktree: { onDone: "keep-branch", onFailure: "delete" } });
    await useBudget({ perTaskUsd: 1.2, onExceed: "fail" });
    await addTask(main, "t1");
    await engine.runUntilIdle();
    expect((await tasksOf(main).get("t1"))?.frontmatter.status).toBe("failed");
    expect(existsSync(join(main.workingDirectory, ".boof-runner-worktrees", "t1"))).toBe(false);
  });

  it("is overridden per project", async () => {
    await useBudget({ perTaskUsd: 100 });
    await projects.update("main", { budget: { perTaskUsd: 0.4 } });
    await addTask(main, "t1");
    await engine.runUntilIdle();
    const t = await tasksOf(main).get("t1");
    expect(t?.frontmatter.status).toBe("failed");
    expect(t?.body.log).toContain("budget exceeded: task:t1");
    expect(mockState.calls).toEqual(["planner"]);
  });
});

describe("day limits", () => {
  it("global: stops the running task, then idles with a budget result and one event", async () => {
    await useBudget({ perDayUsd: 1.2 });
    await addTask(main, "t1");
    await addTask(main, "t2");
    const results = await engine.runUntilIdle();
    expect((await tasksOf(main).get("t1"))?.frontmatter.status).toBe("failed");
    expect((await tasksOf(main).get("t1"))?.body.log).toContain(
      "budget exceeded: global 1.5000/1.2 USD",
    );
    expect((await tasksOf(main).get("t2"))?.frontmatter.status).toBe("pending");
    expect(results.at(-1)).toEqual({ kind: "budget", scopes: ["global"] });
    expect(await engine.tick()).toEqual({ kind: "budget", scopes: ["global"] });
    expect(await engine.tick()).toEqual({ kind: "budget", scopes: ["global"] });
    const events = await budgetEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scope: "global", limitUsd: 1.2 });
  });

  it("starts a new day with an empty ledger", async () => {
    await useBudget({ perDayUsd: 1.2, timezone: "UTC" });
    await addTask(main, "t1");
    await engine.runUntilIdle();
    // Switch to a zone whose date differs from UTC's: its day has no spend yet.
    const other =
      dayKey(new Date(), "UTC") === dayKey(new Date(), "Pacific/Kiritimati")
        ? "Etc/GMT+12"
        : "Pacific/Kiritimati";
    await useBudget({ perDayUsd: 1.2, timezone: other });
    await addTask(main, "t2", 0.01);
    const results = await engine.runUntilIdle();
    expect((await tasksOf(main).get("t2"))?.frontmatter.status).toBe("done");
    expect(results.at(-1)).toEqual({ kind: "idle" });
  });

  it("project: skips the spent project and keeps serving the others", async () => {
    const other = await projects.create({ workingDirectory: await repo(), id: "other" });
    await useBudget({ perProjectDayUsd: 1.2 });
    await addTask(main, "m1", 0.5, { priority: 90 });
    await addTask(main, "m2", 0.5, { priority: 80 });
    await addTask(other, "o1", 0.1, { priority: 10 });
    const results = await engine.runUntilIdle();
    expect((await tasksOf(main).get("m1"))?.frontmatter.status).toBe("failed");
    expect((await tasksOf(main).get("m2"))?.frontmatter.status).toBe("pending");
    expect((await tasksOf(other).get("o1"))?.frontmatter.status).toBe("done");
    expect(results.at(-1)).toEqual({ kind: "budget", scopes: ["project:main"] });
    expect((await budgetEvents()).map((e) => (e as { scope: string }).scope)).toEqual([
      "project:main",
    ]);
  });

  it("project override raises the limit for one project", async () => {
    await useBudget({ perProjectDayUsd: 0.1 });
    await projects.update("main", { budget: { perProjectDayUsd: 50 } });
    await addTask(main, "t1");
    await engine.runUntilIdle();
    expect((await tasksOf(main).get("t1"))?.frontmatter.status).toBe("done");
  });

  it("tool: skips tasks that need the spent tool, not the others", async () => {
    await useBudget({ perToolDayUsd: { mock: 1.2 } });
    await addTask(main, "t1", 0.5, { priority: 90 });
    await addTask(main, "t2", 0.5, { priority: 80 });
    // A task on another tool is not blocked (its tool has no limit and no spend).
    await addTask(main, "t3", 0.5, {
      priority: 10,
      tools: {
        planner: { tool: "codex", model: "x" },
        developer: { tool: "codex", model: "x" },
        reviewer: { tool: "codex", model: "x" },
      },
    });
    const first = await engine.tick();
    expect(first).toMatchObject({ kind: "ran", outcome: { kind: "failed" } });
    expect((await tasksOf(main).get("t1"))?.body.log).toContain("budget exceeded: tool:mock");
    const next = await engine.selectNext();
    expect(next?.task.frontmatter.id).toBe("t3");
  });

  it("tool: reports a budget result when only blocked tasks remain", async () => {
    await useBudget({ perToolDayUsd: { mock: 1.2 } });
    await addTask(main, "t1");
    await addTask(main, "t2");
    const results = await engine.runUntilIdle();
    expect(results.at(-1)).toEqual({ kind: "budget", scopes: ["tool:mock"] });
    expect((await tasksOf(main).get("t2"))?.frontmatter.status).toBe("pending");
  });
});
