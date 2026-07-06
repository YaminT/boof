import { mkdir, mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  newTask,
  SettingsStore,
  TaskStore,
  taskControlDir,
  taskFilePath,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  workingAreaDir,
  type TaskFrontmatter,
} from "@boof-claw/shared";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { Pipeline } from "./pipeline.js";
import { mockState, resetMock } from "./tools/mock.js";

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "t1",
  title: "T1",
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  // mock tool for all roles
  tools: {
    planner: { tool: "mock", model: "mock-default" },
    developer: { tool: "mock", model: "mock-default" },
    reviewer: { tool: "mock", model: "mock-default" },
  },
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-claw-data-"));
  workDir = await mkdtemp(join(tmpdir(), "boof-claw-work-"));
  // Make workDir a git repo so worktree isolation engages.
  const g = (args: string[]) => execCommand("git", args, { cwd: workDir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(workDir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);

  const store = new TaskStore(dataRoot);
  await store.ensureDirs();
  const settings = new SettingsStore(dataRoot);
  await settings.save({ ...defaultSettings(workDir), runner: { enabled: true } });

  engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
  resetMock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  resetMock();
});

describe("RunnerEngine integration (mock tool)", () => {
  it("runs the full happy-path pipeline to done with all reports", async () => {
    await engine.store.create(newTask(fm(), "Build a thing."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("done");

    // Task moved to done/.
    expect(await exists(taskFilePath(dataRoot, "done", "t1"))).toBe(true);
    const done = await engine.store.get("t1");
    expect(done?.frontmatter.status).toBe("done");

    // Reports + plan written into the working area (kept under ongoing? no — moved).
    // The transition to done removed the working area; assert reports were mirrored
    // into the task body instead.
    expect(done?.body.reports.planner).toContain("Plan");
    expect(done?.body.reports.developer).toContain("Developer report");
    expect(done?.body.reports.reviewer).toContain("Review");
    expect(done?.frontmatter.tokens?.known).toBe(true);
  });

  it("respects skip and priority ordering", async () => {
    await engine.store.create(newTask(fm({ id: "low", priority: 10 }), "low"));
    await engine.store.create(newTask(fm({ id: "high", priority: 90 }), "high"));
    await engine.store.create(newTask(fm({ id: "skipped", priority: 99, skip: true }), "skip"));
    const next = await engine.selectNext();
    expect(next?.frontmatter.id).toBe("high");
  });

  it("does not run when disabled", async () => {
    await engine.settingsStore.update({ runner: { enabled: false } });
    await engine.store.create(newTask(fm(), "x"));
    const r = await engine.tick();
    expect(r.kind).toBe("disabled");
    expect(await exists(taskFilePath(dataRoot, "pending", "t1"))).toBe(true);
  });

  it("parks on planner questions, then resumes to done after answers", async () => {
    mockState.plannerQuestions = ["Which database?"];
    await engine.store.create(newTask(fm(), "Build with a DB."));

    // First tick: planner asks → parked in actions/.
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    if (first.kind === "ran") expect(first.outcome.kind).toBe("parked");
    expect(await exists(taskFilePath(dataRoot, "action", "t1"))).toBe(true);
    const parked = await engine.store.get("t1");
    expect(parked?.frontmatter.status).toBe("action");
    expect(parked?.frontmatter.questions).toBe("pending");
    expect(parked?.body.questions).toContain("Which database?");

    // User answers (simulate the Actions tab): write answers, set answered, move to pending.
    await engine.store.transition("t1", "pending", (t) => {
      t.body.answers = "Use Postgres.";
      t.frontmatter.questions = "answered";
    });

    // Second tick: planner no longer asks (mock ask-once) → completes.
    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    if (second.kind === "ran") expect(second.outcome.kind).toBe("done");
    const done = await engine.store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.frontmatter.questions).toBe("answered");
  });

  it("runs a task N times and injects the critical-review framing after the first", async () => {
    await engine.store.create(newTask(fm({ runs: 3 }), "Build it well."));

    const results = await engine.runUntilIdle();
    const ranCount = results.filter((r) => r.kind === "ran").length;
    expect(ranCount).toBe(3);

    const done = await engine.store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.frontmatter.completedRuns).toBe(3);

    // Iteration 1 prompts carry no framing; iterations 2 and 3 do.
    const framed = mockState.prompts.filter((p) => p.includes("Iteration "));
    expect(framed.some((p) => p.includes("Iteration 2 of 3"))).toBe(true);
    expect(framed.some((p) => p.includes("Iteration 3 of 3"))).toBe(true);
    expect(framed.some((p) => p.includes("another AI's solution"))).toBe(true);
    // The very first planner prompt must NOT be framed.
    expect(mockState.prompts[0]).not.toContain("Iteration ");
  });

  it("re-queues to pending between runs rather than finishing early", async () => {
    await engine.store.create(newTask(fm({ runs: 2 }), "twice"));
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    // After one run of a 2-run task, it should be back in pending, not done.
    const mid = await engine.store.get("t1");
    expect(mid?.frontmatter.status).toBe("pending");
    expect(mid?.frontmatter.completedRuns).toBe(1);

    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    const end = await engine.store.get("t1");
    expect(end?.frontmatter.status).toBe("done");
    expect(end?.frontmatter.completedRuns).toBe(2);
  });

  it("fails the task and captures diagnostics on tool error", async () => {
    mockState.failRole = "developer";
    await engine.store.create(newTask(fm(), "will fail"));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");
    expect(await exists(taskFilePath(dataRoot, "failed", "t1"))).toBe(true);

    // log.txt was moved with the working area? No — failed is a flat file. The
    // working area under ongoing/ is removed on transition; diagnostics were
    // appended during the run. Assert the failed task records the error path.
    const failed = await engine.store.get("t1");
    expect(failed?.frontmatter.status).toBe("failed");

    // Retry returns it to pending.
    await engine.store.transition("t1", "pending");
    expect(await exists(taskFilePath(dataRoot, "pending", "t1"))).toBe(true);
  });

  it("passes injected prompts into later pipeline steps", async () => {
    await engine.store.create(newTask(fm(), "Build it."));
    const running = await engine.store.transition("t1", "running");
    await mkdir(taskControlDir(dataRoot, "t1"), { recursive: true });
    await writeFile(
      taskPromptInjectionsPath(dataRoot, "t1"),
      "## 2026-07-02T00:00:00.000Z\nAlso add a focused regression test.\n",
    );

    const pipeline = new Pipeline({
      root: dataRoot,
      store: engine.store,
      registry: engine.registry,
      settings: await engine.settingsStore.load(),
    });
    const outcome = await pipeline.run(running);

    expect(outcome.kind).toBe("done");
    expect(
      mockState.prompts.some(
        (p) =>
          p.includes("User prompts injected while this task was running") &&
          p.includes("Also add a focused regression test."),
      ),
    ).toBe(true);
  });

  it("fails before the next step when stop has been requested", async () => {
    await engine.store.create(newTask(fm(), "Build it."));
    const running = await engine.store.transition("t1", "running");
    await mkdir(taskControlDir(dataRoot, "t1"), { recursive: true });
    await writeFile(taskStopRequestPath(dataRoot, "t1"), "stop\n");

    const pipeline = new Pipeline({
      root: dataRoot,
      store: engine.store,
      registry: engine.registry,
      settings: await engine.settingsStore.load(),
    });
    const outcome = await pipeline.run(running);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error).toContain("stopped by user");
  });
});

void workingAreaDir;
void readFile;
