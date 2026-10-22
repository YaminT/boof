import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentStatus,
  defaultSettings,
  newTask,
  parseGoal,
  SettingsStore,
  TaskStore,
  taskControlDir,
  taskFilePath,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  workingAreaDir,
  type TaskFrontmatter,
} from "@boof-runner/shared";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { Pipeline } from "./pipeline.js";
import { ensureWorktree } from "./worktree.js";
import { mockState, resetMock } from "./tools/mock.js";
import type { RunOptions } from "./tools/types.js";

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

const wtPath = (id = "t1") => join(workDir, ".boof-runner-worktrees", id);
const gitOut = (args: string[], cwd = workDir) =>
  execCommand("git", args, { cwd, timeoutMs: 15000 });
const writeIn = (opts: RunOptions, file: string, content = "x\n") =>
  writeFile(join(opts.cwd, file), content);
const commitIn = async (opts: RunOptions, file: string) => {
  await writeIn(opts, file);
  await gitOut(["add", file], opts.cwd);
  await gitOut(["commit", "-m", "agent"], opts.cwd);
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
  dataRoot = await mkdtemp(join(tmpdir(), "boof-runner-data-"));
  workDir = await mkdtemp(join(tmpdir(), "boof-runner-work-"));
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
    const wt = await ensureWorktree(workDir, "t1");
    await writeFile(join(wt.path, "wip.txt"), "wip\n");
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

    // Stopped work is kept: worktree directory and task branch survive.
    expect(await exists(wtPath())).toBe(true);
    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["status", "--porcelain"], wtPath())).stdout).toContain("wip.txt");
    if (outcome.kind === "failed") expect(outcome.task.body.log).toContain("Kept worktree");
  });

  it("bumps a scanned unit's goal.boof.xml status on successful completion", async () => {
    const goalXml = `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>Build the core.</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;
    await mkdir(join(workDir, "core"), { recursive: true });
    await writeFile(join(workDir, "core", "goal.boof.xml"), goalXml, "utf8");

    await engine.store.create(
      newTask(fm({ boofGoal: { path: "core/goal.boof.xml", bumpTo: "done" } }), "Implement core."),
    );
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("done");

    // The goal file gained a version with status done.
    const after = parseGoal(await readFile(join(workDir, "core", "goal.boof.xml"), "utf8"));
    expect(currentStatus(after)).toBe("done");
    expect(after.progress.versions).toHaveLength(2);
  });
});

void workingAreaDir;
void readFile;

describe("task work is never destroyed", () => {
  it("done: keeps the branch with the agent's commit and removes the clean directory", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") await commitIn(opts, "a.txt");
    };
    await engine.store.create(newTask(fm(), "Build it."));
    await engine.tick();

    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["log", "--format=%s", "boof-runner/t1"])).stdout).toContain("agent");
    expect(await exists(wtPath())).toBe(false);
    const done = await engine.store.get("t1");
    expect(done?.body.log).toMatch(/Task branch boof-runner\/t1 at [0-9a-f]{40}/);
  });

  it("done with leftovers: commits them on the branch, then removes the directory", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") await writeIn(opts, "left.txt");
    };
    await engine.store.create(newTask(fm(), "Build it."));
    await engine.tick();

    expect((await gitOut(["log", "-1", "--format=%s", "boof-runner/t1"])).stdout.trim()).toBe(
      "boof-runner: T1",
    );
    expect((await gitOut(["show", "boof-runner/t1:left.txt"])).code).toBe(0);
    expect(await exists(wtPath())).toBe(false);
  });

  it("failure: keeps the directory, the branch and uncommitted changes", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "planner") await writeIn(opts, "wip.txt");
    };
    mockState.failRole = "developer";
    await engine.store.create(newTask(fm(), "will fail"));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");

    expect(await exists(join(wtPath(), "wip.txt"))).toBe(true);
    expect((await gitOut(["status", "--porcelain"], wtPath())).stdout).toContain("wip.txt");
    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    const failed = await engine.store.get("t1");
    expect(failed?.body.log).toMatch(/Kept worktree .* on branch boof-runner\/t1 at [0-9a-f]{40}/);
  });

  it("multi-run: iteration 2 sees iteration 1's work in the same worktree", async () => {
    let iter2Saw: boolean | null = null;
    const cwds = new Set<string>();
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      cwds.add(opts.cwd);
      if (!existsSync(join(opts.cwd, "iter1.txt"))) await writeIn(opts, "iter1.txt");
      else iter2Saw = true;
    };
    await engine.store.create(newTask(fm({ runs: 2 }), "twice"));
    await engine.tick();
    await engine.tick();

    expect(iter2Saw).toBe(true);
    expect(cwds.size).toBe(1);
    expect((await gitOut(["log", "-1", "--format=%s", "boof-runner/t1"])).stdout.trim()).toBe(
      "boof-runner: T1",
    );
    expect((await gitOut(["show", "boof-runner/t1:iter1.txt"])).code).toBe(0);
  });

  it("unregistered directory at the worktree path: fails clearly, leaves it untouched", async () => {
    await mkdir(wtPath(), { recursive: true });
    await writeFile(join(wtPath(), "keep.txt"), "sentinel");
    await engine.store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") {
      expect(r.outcome.kind).toBe("failed");
      if (r.outcome.kind === "failed") expect(r.outcome.error).toContain(wtPath());
    }
    expect(await readFile(join(wtPath(), "keep.txt"), "utf8")).toBe("sentinel");
    expect(
      (await gitOut(["rev-parse", "--verify", "--quiet", "refs/heads/boof-runner/t1"])).code,
    ).not.toBe(0);
  });

  it("retry: reuses the kept branch and its earlier commit", async () => {
    const cwds: string[] = [];
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      cwds.push(opts.cwd);
      if (!existsSync(join(opts.cwd, "a.txt"))) await commitIn(opts, "a.txt");
    };
    mockState.failRole = "reviewer";
    await engine.store.create(newTask(fm(), "Build it."));
    const first = await engine.tick();
    if (first.kind === "ran") expect(first.outcome.kind).toBe("failed");
    const sha1 = (await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim();

    await engine.store.transition("t1", "pending");
    mockState.failRole = null;
    const second = await engine.tick();
    if (second.kind === "ran") expect(second.outcome.kind).toBe("done");

    expect((await gitOut(["merge-base", "--is-ancestor", sha1, "boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["show", "boof-runner/t1:a.txt"])).code).toBe(0);
    expect(cwds).toEqual([wtPath(), wtPath()]);
  });
});

describe("observer, verdict gate and fix loop (mock tool)", () => {
  const MOCK = { tool: "mock", model: "mock-default" };
  const withObserver = async (review?: {
    gate?: boolean;
    maxFixRounds?: number;
    maxInlineDiffBytes?: number;
  }) => {
    const s = await engine.settingsStore.load();
    await engine.settingsStore.save({
      ...s,
      roles: { ...s.roles, observer: MOCK },
      ...(review
        ? { review: { gate: true, maxFixRounds: 2, maxInlineDiffBytes: 120000, ...review } }
        : {}),
    });
  };
  const runTask = async (prompt: string, over: Partial<TaskFrontmatter> = {}) => {
    await engine.store.create(newTask(fm(over), prompt));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    return r.outcome;
  };
  const count = (role: string) => mockState.calls.filter((c) => c === role).length;
  const branchKept = async () =>
    (await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code === 0;

  it("observer absent: no observer call, task done", async () => {
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    expect(mockState.calls).not.toContain("observer");
    expect(count("reviewer")).toBe(1);
  });

  it("observer present: runs after the developer, report recorded with round", async () => {
    await withObserver();
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "observer", "reviewer"]);
    const done = await engine.store.get("t1");
    expect(done?.body.reports.observer).toContain("Round 1 — APPROVE");
    expect(done?.body.reports.reviewer).toContain("Round 1 — APPROVE");
    expect(done?.body.log).toContain("Observer verdict (round 1): APPROVE");
    expect(done?.body.log).toContain("Reviewer verdict (round 1): APPROVE");
  });

  it("observer CHANGES_REQUESTED then APPROVE: developer runs twice, task done", async () => {
    await withObserver();
    const out = await runTask("x [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE]]");
    expect(out.kind).toBe("done");
    expect(count("developer")).toBe(2);
    expect(count("observer")).toBe(2);
    expect(mockState.prompts.some((p) => p.includes("mock issue observer round 1"))).toBe(true);
    const dev2 = mockState.prompts.filter((p) => p.includes("## Findings (observer round 1)"));
    expect(dev2).toHaveLength(1);
    expect(dev2[0]).toContain("mock issue observer round 1");
    expect(dev2[0]).toContain("rebut it with evidence");
    expect(dev2[0]).toContain("## Plan");
    const done = await engine.store.get("t1");
    expect(done?.body.reports.observer).toContain("Round 1 — CHANGES_REQUESTED");
    expect(done?.body.reports.observer).toContain("Round 2 — APPROVE");
    expect(done?.body.reports.developer).toContain("Fix round 1 (observer)");
  });

  it("reviewer CHANGES_REQUESTED then APPROVE: fix and re-review, task done", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]");
    expect(out.kind).toBe("done");
    expect(count("developer")).toBe(2);
    expect(count("reviewer")).toBe(2);
    expect(mockState.prompts.some((p) => p.includes("## Findings (reviewer round 1)"))).toBe(true);
  });

  it("reviewer fix is re-checked by the observer before the reviewer re-checks", async () => {
    await withObserver();
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]");
    expect(out.kind).toBe("done");
    expect(mockState.calls.slice(2)).toEqual([
      "developer",
      "observer",
      "reviewer",
      "developer",
      "observer",
      "reviewer",
    ]);
  });

  it("budget exhausted: fails, keeps worktree and branch", async () => {
    await withObserver({ maxFixRounds: 1 });
    const out = await runTask("x [[mock-verdicts observer=CHANGES_REQUESTED]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toBe("review not approved: observer CHANGES_REQUESTED");
    }
    expect(count("developer")).toBe(2);
    expect(count("reviewer")).toBe(0);
    expect(await exists(wtPath())).toBe(true);
    expect(await branchKept()).toBe(true);
    expect(await exists(taskFilePath(dataRoot, "failed", "t1"))).toBe(true);
  });

  it("reviewer budget exhausted: fails with reviewer reason", async () => {
    await engine.settingsStore.update({
      review: { gate: true, maxFixRounds: 1, maxInlineDiffBytes: 120000 },
    });
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toBe("review not approved: reviewer CHANGES_REQUESTED");
    }
    expect(count("reviewer")).toBe(2);
    expect(await exists(wtPath())).toBe(true);
    expect(await branchKept()).toBe(true);
  });

  it("maxFixRounds 0: first CHANGES_REQUESTED fails without a fix round", async () => {
    await engine.settingsStore.update({
      review: { gate: true, maxFixRounds: 0, maxInlineDiffBytes: 120000 },
    });
    const out = await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED]]");
    expect(out.kind).toBe("failed");
    expect(count("developer")).toBe(1);
  });

  it("REJECT from the reviewer fails the task without a fix round", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=REJECT]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: reviewer REJECT");
    expect(count("developer")).toBe(1);
    expect(await branchKept()).toBe(true);
  });

  it("REJECT from the observer fails before the reviewer runs", async () => {
    await withObserver();
    const out = await runTask("x [[mock-verdicts observer=REJECT]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: observer REJECT");
    expect(count("reviewer")).toBe(0);
  });

  it.each(["NONE", "GARBLED", "CONFLICT"])("%s verdict is not approved", async (token) => {
    const out = await runTask(`x [[mock-verdicts reviewer=${token}]]`);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: reviewer INVALID");
    expect(count("developer")).toBe(1);
    expect(await exists(wtPath())).toBe(true);
    expect(await branchKept()).toBe(true);
  });

  it.each(["NONE", "GARBLED", "CONFLICT"])("observer %s verdict is not approved", async (token) => {
    await withObserver();
    const out = await runTask(`x [[mock-verdicts observer=${token}]]`);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("review not approved: observer INVALID");
    expect(count("reviewer")).toBe(0);
  });

  it("unknown mock verdict token fails the task", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=BOGUS]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toContain("unknown mock verdict token: BOGUS");
  });

  it("scripted verdict rounds restart each iteration (runs: 2)", async () => {
    await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]", { runs: 2 });
    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    const end = await engine.store.get("t1");
    expect(end?.frontmatter.status).toBe("done");
    expect(count("developer")).toBe(4);
    expect(count("reviewer")).toBe(4);
  });

  it("gate false: verdicts are recorded but not enforced", async () => {
    await withObserver({ gate: false });
    const out = await runTask("x [[mock-verdicts observer=CHANGES_REQUESTED reviewer=REJECT]]");
    expect(out.kind).toBe("done");
    expect(count("developer")).toBe(1);
    expect(count("observer")).toBe(1);
    expect(count("reviewer")).toBe(1);
    const done = await engine.store.get("t1");
    expect(done?.body.log).toContain("Observer verdict (round 1): CHANGES_REQUESTED");
    expect(done?.body.log).toContain("Reviewer verdict (round 1): REJECT");
    expect(done?.body.reports.reviewer).toContain("Round 1 — REJECT");
  });

  it("per-task tools.observer enables the observer without a global one", async () => {
    const out = await runTask("x", { tools: { ...fm().tools, observer: MOCK } });
    expect(out.kind).toBe("done");
    expect(count("observer")).toBe(1);
  });

  it("caps an over-limit diff in prompts and logs it", async () => {
    await withObserver({ maxInlineDiffBytes: 50 });
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer") return;
      await writeIn(opts, "big.txt", "y".repeat(1024) + "\n");
      await gitOut(["add", "big.txt"], opts.cwd);
    };
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    const base = (await gitOut(["rev-parse", "main"])).stdout.trim();
    const reviewPrompt = mockState.prompts.find((p) => p.includes("## Diff under review"))!;
    expect(reviewPrompt).toContain("exceeds the inline limit");
    expect(reviewPrompt).toContain(`git diff ${base}`);
    expect(reviewPrompt).toContain("big.txt");
    expect(reviewPrompt).not.toContain("yyyyyyyyyy");
    const done = await engine.store.get("t1");
    expect(done?.body.log).toContain("Diff exceeds inline limit");
  });

  it("inlines the full diff when under the limit", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") await commitIn(opts, "small.txt");
    };
    const out = await runTask("x");
    expect(out.kind).toBe("done");
    const reviewPrompt = mockState.prompts.find((p) => p.includes("## Diff under review"))!;
    expect(reviewPrompt).toContain("## Diff\n");
    expect(reviewPrompt).not.toContain("exceeds the inline limit");
  });
});
