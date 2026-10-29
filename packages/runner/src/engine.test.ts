import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  stat,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentStatus,
  defaultSettings,
  effectiveSettings,
  newTask,
  ProjectStore,
  parseGoal,
  serializeTask,
  SettingsStore,
  TaskStore,
  parseInjected,
  taskControlDir,
  taskFilePath,
  taskPromptInjectionsPath,
  taskSteerRequestPath,
  taskStopRequestPath,
  workingAreaDir,
  type Project,
  type TaskFrontmatter,
} from "@boof-runner/shared";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { NON_INTERACTIVE, Pipeline, SYSTEM_PROMPTS } from "./pipeline.js";
import { ensureWorktree } from "./worktree.js";
import { ToolRunError } from "./tools/errors.js";
import { mockState, resetMock } from "./tools/mock.js";
import type { RunOptions } from "./tools/types.js";

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;
/** The project under test: `workDir` registered as project `default`. */
let project: Project;
let projectDir: string;
let store: TaskStore;

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
  workDir = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-work-")));
  // Make workDir a git repo so worktree isolation engages.
  const g = (args: string[]) => execCommand("git", args, { cwd: workDir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(workDir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);

  await new SettingsStore(dataRoot).save({
    ...defaultSettings(),
    runner: { enabled: true, concurrency: 1 },
    defaultProject: "default",
  });
  project = await new ProjectStore(dataRoot).create({ workingDirectory: workDir, id: "default" });
  projectDir = new ProjectStore(dataRoot).dir(project.id);
  store = new TaskStore(projectDir);

  engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
  resetMock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

describe("RunnerEngine integration (mock tool)", () => {
  it("runs the full happy-path pipeline to done with all reports", async () => {
    await store.create(newTask(fm(), "Build a thing."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("done");

    // Task moved to done/.
    expect(await exists(taskFilePath(projectDir, "done", "t1"))).toBe(true);
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");

    // Reports + plan written into the working area (kept under ongoing? no — moved).
    // The transition to done removed the working area; assert reports were mirrored
    // into the task body instead.
    expect(done?.body.reports.planner).toContain("Plan");
    expect(done?.body.reports.developer).toContain("Developer report");
    expect(done?.body.reports.reviewer).toContain("Review");
    expect(done?.frontmatter.tokens?.known).toBe(true);
  });

  it("records each pipeline step with a time", async () => {
    await store.create(newTask(fm(), "Build a thing."));
    await engine.tick();
    const done = (await store.get("t1"))!;
    const steps = done.frontmatter.steps!;
    const labels = steps.map((s) => s.label);
    expect(labels.slice(0, 3)).toEqual(["Planner", "Planner (refinement)", "Developer"]);
    expect(labels.some((l) => l.startsWith("Reviewer (round 1"))).toBe(true);
    const times = steps.map((s) => Date.parse(s.at));
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Date.parse(done.frontmatter.startedAt!)).toBeLessThanOrEqual(times[0]!);
  });

  it("respects skip and priority ordering", async () => {
    await store.create(newTask(fm({ id: "low", priority: 10 }), "low"));
    await store.create(newTask(fm({ id: "high", priority: 90 }), "high"));
    await store.create(newTask(fm({ id: "skipped", priority: 99, skip: true }), "skip"));
    const next = await engine.selectNext();
    expect(next?.task.frontmatter.id).toBe("high");
    expect(next?.project.id).toBe("default");
  });

  it("does not run when disabled", async () => {
    await engine.settingsStore.update({ runner: { enabled: false } });
    await store.create(newTask(fm(), "x"));
    const r = await engine.tick();
    expect(r.kind).toBe("disabled");
    expect(await exists(taskFilePath(projectDir, "pending", "t1"))).toBe(true);
  });

  it("parks on planner questions, then resumes to done after answers", async () => {
    mockState.plannerQuestions = ["Which database?"];
    await store.create(newTask(fm(), "Build with a DB."));

    // First tick: planner asks → parked in actions/.
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    if (first.kind === "ran") expect(first.outcome.kind).toBe("parked");
    expect(await exists(taskFilePath(projectDir, "action", "t1"))).toBe(true);
    const parked = await store.get("t1");
    expect(parked?.frontmatter.status).toBe("action");
    expect(parked?.frontmatter.questions).toBe("pending");
    expect(parked?.body.questions).toContain("Which database?");

    // User answers (simulate the Actions tab): write answers, set answered, move to pending.
    await store.transition("t1", "pending", (t) => {
      t.body.answers = "Use Postgres.";
      t.frontmatter.questions = "answered";
    });

    // Second tick: planner no longer asks (mock ask-once) → completes.
    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    if (second.kind === "ran") expect(second.outcome.kind).toBe("done");
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.frontmatter.questions).toBe("answered");
  });

  it("edits to title, labels and runs made during a run survive it and set the run count", async () => {
    await store.create(newTask(fm(), "Build a thing."));
    let edited = false;
    mockState.onRun = async (opts) => {
      if (opts.role !== "developer" || edited) return;
      edited = true;
      const t = (await store.get("t1"))!;
      t.frontmatter.title = "Renamed";
      t.frontmatter.labels = ["edited"];
      t.frontmatter.runs = 3;
      await store.save(t);
    };
    await engine.tick();
    const after = (await store.get("t1"))!;
    expect(after.frontmatter.status).toBe("pending"); // run 1 of 3 done, re-queued
    expect(after.frontmatter.completedRuns).toBe(1);
    expect(after.frontmatter.runs).toBe(3);
    expect(after.frontmatter.title).toBe("Renamed");
    expect(after.frontmatter.labels).toEqual(["edited"]);
    expect(after.body.reports.developer).not.toBe("");
    expect(after.frontmatter.tokens).toBeDefined();
  });

  it("runs a task N times and injects the critical-review framing after the first", async () => {
    await store.create(newTask(fm({ runs: 3 }), "Build it well."));

    const results = await engine.runUntilIdle();
    const ranCount = results.filter((r) => r.kind === "ran").length;
    expect(ranCount).toBe(3);

    const done = await store.get("t1");
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
    await store.create(newTask(fm({ runs: 2 }), "twice"));
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    // After one run of a 2-run task, it should be back in pending, not done.
    const mid = await store.get("t1");
    expect(mid?.frontmatter.status).toBe("pending");
    expect(mid?.frontmatter.completedRuns).toBe(1);

    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    const end = await store.get("t1");
    expect(end?.frontmatter.status).toBe("done");
    expect(end?.frontmatter.completedRuns).toBe(2);
  });

  it("fails the task and captures diagnostics on tool error", async () => {
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "will fail"));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");
    expect(await exists(taskFilePath(projectDir, "failed", "t1"))).toBe(true);

    // log.txt was moved with the working area? No — failed is a flat file. The
    // working area under ongoing/ is removed on transition; diagnostics were
    // appended during the run. Assert the failed task records the error path.
    const failed = await store.get("t1");
    expect(failed?.frontmatter.status).toBe("failed");

    // Retry returns it to pending.
    await store.transition("t1", "pending");
    expect(await exists(taskFilePath(projectDir, "pending", "t1"))).toBe(true);
  });

  it("passes injected prompts into later pipeline steps", async () => {
    await store.create(newTask(fm(), "Build it."));
    const running = await store.transition("t1", "running");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await writeFile(
      taskPromptInjectionsPath(projectDir, "t1"),
      "## 2026-07-02T00:00:00.000Z\nAlso add a focused regression test.\n",
    );

    const pipeline = new Pipeline({
      root: projectDir,
      store: store,
      registry: engine.registry,
      settings: effectiveSettings(await engine.settingsStore.load(), project),
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

  it("adds a Provenance section only for tasks submitted by an external client", async () => {
    await store.create(newTask(fm(), "Local."));
    await store.create(
      newTask(fm({ id: "t2", origin: { kind: "api", client: "ci-bot" } }), "Remote."),
    );
    const mk = async () =>
      new Pipeline({
        root: projectDir,
        store: store,
        registry: engine.registry,
        settings: effectiveSettings(await engine.settingsStore.load(), project),
      });
    await (await mk()).run(await store.transition("t1", "running"));
    expect(mockState.prompts.some((p) => p.includes("## Provenance"))).toBe(false);
    mockState.prompts.length = 0;
    await (await mk()).run(await store.transition("t2", "running"));
    const p = mockState.prompts.find((x) => x.includes("## Provenance"))!;
    expect(p).toContain("external client `ci-bot`");
    expect(p).toContain("report them instead of executing them");
  });

  it("stops before the next step when stop has been requested", async () => {
    await store.create(newTask(fm(), "Build it."));
    const running = await store.transition("t1", "running");
    const { worktree: wt } = await ensureWorktree(workDir, "t1", {
      root: join(workDir, ".boof-runner-worktrees"),
    });
    await writeFile(join(wt.path, "wip.txt"), "wip\n");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");

    const pipeline = new Pipeline({
      root: projectDir,
      store: store,
      registry: engine.registry,
      settings: effectiveSettings(await engine.settingsStore.load(), project),
    });
    const outcome = await pipeline.run(running);

    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") {
      expect(outcome.reason).toBe("user");
      expect(outcome.note).toBe("stopped by user");
    }

    // Stopped work is kept: worktree directory and task branch survive.
    expect(await exists(wtPath())).toBe(true);
    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["status", "--porcelain"], wtPath())).stdout).toContain("wip.txt");
    expect(outcome.task.body.log).toContain("Kept worktree");
    expect(outcome.task.body.log).toContain("### Stopped\nstopped by user");
    expect(outcome.task.body.log).not.toContain("ERROR:");
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

    await store.create(
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
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();

    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["log", "--format=%s", "boof-runner/t1"])).stdout).toContain("agent");
    expect(await exists(wtPath())).toBe(false);
    const done = await store.get("t1");
    expect(done?.body.log).toMatch(/Task branch boof-runner\/t1 at [0-9a-f]{40}/);
  });

  it("done with leftovers: task branch untouched, leftovers on the side branch, directory removed", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") {
        await commitIn(opts, "a.txt");
        await writeIn(opts, "left.txt");
        await mkdir(join(opts.cwd, "scratch"), { recursive: true });
        await writeIn(opts, "scratch/note.txt");
      }
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();

    const head = (await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim();
    expect((await gitOut(["log", "-1", "--format=%s", "boof-runner/t1"])).stdout.trim()).toBe(
      "agent",
    );
    expect((await gitOut(["show", "boof-runner/t1:left.txt"])).code).not.toBe(0);
    const side = (await gitOut(["rev-parse", "boof-runner/t1--leftovers"])).stdout.trim();
    expect(side).toMatch(/^[0-9a-f]{40}$/);
    expect((await gitOut(["rev-parse", `${side}^`])).stdout.trim()).toBe(head);
    expect((await gitOut(["show", "boof-runner/t1--leftovers:left.txt"])).code).toBe(0);
    expect(await exists(wtPath())).toBe(false);
    const done = await store.get("t1");
    expect(done?.body.log).toContain(`Leftovers committed to boof-runner/t1--leftovers at ${side}`);
  });

  it("done with a nested git repository: keeps the directory and says why", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") {
        await commitIn(opts, "a.txt");
        await mkdir(join(opts.cwd, "scratch", "nested"), { recursive: true });
        await gitOut(["init", "-b", "main"], join(opts.cwd, "scratch", "nested"));
        await writeIn(opts, "scratch/nested/f.txt");
      }
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();

    expect(await exists(join(wtPath(), "scratch", "nested", "f.txt"))).toBe(true);
    const log = (await store.get("t1"))?.body.log ?? "";
    expect(log).toContain("nested git repositories are not saved");
    expect(log).not.toContain("Removed worktree directory");
  });

  it("failure: keeps the directory, the branch and uncommitted changes", async () => {
    mockState.onRun = async (opts) => {
      if (opts.role === "planner") await writeIn(opts, "wip.txt");
    };
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "will fail"));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");

    expect(await exists(join(wtPath(), "wip.txt"))).toBe(true);
    expect((await gitOut(["status", "--porcelain"], wtPath())).stdout).toContain("wip.txt");
    expect((await gitOut(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
    const failed = await store.get("t1");
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
    await store.create(newTask(fm({ runs: 2 }), "twice"));
    await engine.tick();
    await engine.tick();

    expect(iter2Saw).toBe(true);
    expect(cwds.size).toBe(1);
    expect((await gitOut(["show", "boof-runner/t1--leftovers:iter1.txt"])).code).toBe(0);
  });

  it("unregistered directory at the worktree path: fails clearly, leaves it untouched", async () => {
    await mkdir(wtPath(), { recursive: true });
    await writeFile(join(wtPath(), "keep.txt"), "sentinel");
    await store.create(newTask(fm(), "Build it."));
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
    await store.create(newTask(fm(), "Build it."));
    const first = await engine.tick();
    if (first.kind === "ran") expect(first.outcome.kind).toBe("failed");
    const sha1 = (await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim();

    await store.transition("t1", "pending");
    mockState.failRole = null;
    const second = await engine.tick();
    if (second.kind === "ran") expect(second.outcome.kind).toBe("done");

    expect((await gitOut(["merge-base", "--is-ancestor", sha1, "boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["show", "boof-runner/t1:a.txt"])).code).toBe(0);
    expect(cwds).toEqual([wtPath(), wtPath()]);
  });
});

describe("retention policies", () => {
  const withWorktree = async (worktree: {
    root?: string;
    onDone?: "keep-branch" | "keep" | "delete";
    onFailure?: "keep" | "delete";
  }) => {
    const store = new SettingsStore(dataRoot);
    const cur = await store.load();
    await store.save({
      ...cur,
      worktree: { onDone: "keep-branch", onFailure: "keep", ...worktree },
    });
  };
  const hasBranch = async (b: string) =>
    (await gitOut(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0;
  const dirty = (role: string) => async (opts: RunOptions) => {
    if (opts.role === role) {
      await commitIn(opts, "a.txt");
      await writeIn(opts, "left.txt");
    }
  };

  it("defaults: a failed task keeps directory and branch; a done task keeps the branch only", async () => {
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "fail"));
    await engine.tick();
    expect(await exists(wtPath())).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
  });

  it("onDone=keep: leaves the directory (dirty) and saves leftovers on the side branch", async () => {
    await withWorktree({ onDone: "keep" });
    mockState.onRun = dirty("developer");
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    expect(await exists(join(wtPath(), "left.txt"))).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
    expect((await gitOut(["show", "boof-runner/t1--leftovers:left.txt"])).code).toBe(0);
    expect((await gitOut(["show", "boof-runner/t1:left.txt"])).code).not.toBe(0);
  });

  it("onDone=delete: removes directory and branches and logs loudly", async () => {
    await withWorktree({ onDone: "delete" });
    mockState.onRun = dirty("developer");
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    expect(await exists(wtPath())).toBe(false);
    expect(await hasBranch("boof-runner/t1")).toBe(false);
    expect(await hasBranch("boof-runner/t1--leftovers")).toBe(false);
    const done = await store.get("t1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.body.log).toContain("WARNING: DELETED task work");
  });

  it("onFailure=keep (explicit): keeps directory and branch", async () => {
    await withWorktree({ onFailure: "keep" });
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "fail"));
    await engine.tick();
    expect(await exists(wtPath())).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
  });

  it("onFailure=delete: removes directory and branch and logs loudly", async () => {
    await withWorktree({ onFailure: "delete" });
    mockState.onRun = dirty("planner");
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "fail"));
    const r = await engine.tick();
    if (r.kind === "ran") expect(r.outcome.kind).toBe("failed");
    expect(await exists(wtPath())).toBe(false);
    expect(await hasBranch("boof-runner/t1")).toBe(false);
    expect((await store.get("t1"))?.body.log).toContain("WARNING: DELETED task work");
  });

  it("onFailure=delete never deletes a stopped task's work", async () => {
    await withWorktree({ onFailure: "delete" });
    await store.create(newTask(fm(), "Build it."));
    const running = await store.transition("t1", "running");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");
    const pipeline = new Pipeline({
      root: projectDir,
      store: store,
      registry: engine.registry,
      settings: effectiveSettings(await engine.settingsStore.load(), project),
    });
    const outcome = await pipeline.run(running);
    expect(outcome.kind).toBe("stopped");
    expect(await exists(wtPath())).toBe(true);
    expect(await hasBranch("boof-runner/t1")).toBe(true);
  });

  it("worktree.root outside the repository: worktree and sidecar live there", async () => {
    const outside = await mkdtemp(join(tmpdir(), "boof-runner-wtroot-"));
    try {
      await withWorktree({ root: outside, onDone: "keep" });
      const cwds: string[] = [];
      mockState.onRun = async (opts) => void cwds.push(opts.cwd);
      await store.create(newTask(fm(), "Build it."));
      await engine.tick();
      expect(cwds.every((c) => c === join(outside, "t1"))).toBe(true);
      expect(await exists(join(outside, "t1"))).toBe(true);
      expect(await exists(join(outside, ".meta", "t1.json"))).toBe(true);
      expect(await exists(join(workDir, ".boof-runner-worktrees"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("base ref (mock tool)", () => {
  it("starts from base, logs the resolved sha, and the diff excludes earlier commits", async () => {
    await gitOut(["branch", "release"]);
    await writeFile(join(workDir, "later.txt"), "later\n");
    await gitOut(["add", "."]);
    await gitOut(["commit", "-m", "later"]);
    const baseSha = (await gitOut(["rev-parse", "release"])).stdout.trim();
    let sawLater: boolean | null = null;
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") sawLater = existsSync(join(opts.cwd, "later.txt"));
    };
    await store.create(newTask(fm({ base: "release" }), "Build it."));
    await engine.tick();
    expect(sawLater).toBe(false);
    expect((await gitOut(["merge-base", "--is-ancestor", baseSha, "boof-runner/t1"])).code).toBe(0);
    expect((await gitOut(["rev-parse", "boof-runner/t1"])).stdout.trim()).toBe(baseSha);
    expect((await store.get("t1"))?.body.log).toContain(`base release → ${baseSha}`);
  });

  it("without a base the log names the branch checked out in the project", async () => {
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    const head = (await gitOut(["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await gitOut(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    expect((await store.get("t1"))?.body.log).toContain(`base ${branch} → ${head}`);
  });

  it("an unknown base fails the task clearly and creates nothing", async () => {
    await store.create(newTask(fm({ base: "no-such-ref" }), "Build it."));
    const r = await engine.tick();
    expect(r.kind).toBe("ran");
    if (r.kind === "ran" && r.outcome.kind === "failed") {
      expect(r.outcome.error).toContain("unknown base ref 'no-such-ref'");
    } else throw new Error("expected failed");
    expect(await exists(wtPath())).toBe(false);
    expect(await exists(join(workDir, ".boof-runner-worktrees"))).toBe(false);
    expect((await gitOut(["branch", "--list", "boof-runner/*"])).stdout.trim()).toBe("");
  });

  it("a reused branch ignores base and the log says so", async () => {
    mockState.failRole = "reviewer";
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    await gitOut(["branch", "other"]);
    const t = await store.get("t1");
    t!.frontmatter.base = "other";
    await store.save(t!);
    await store.transition("t1", "pending");
    mockState.failRole = null;
    await engine.tick();
    expect((await store.get("t1"))?.body.log).toContain(
      "base other ignored: reusing existing branch boof-runner/t1",
    );
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
    await store.create(newTask(fm(over), prompt));
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
    const done = await store.get("t1");
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
    const done = await store.get("t1");
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
    expect(await exists(taskFilePath(projectDir, "failed", "t1"))).toBe(true);
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

  it("labels each findings block with its source round and role", async () => {
    await withObserver({ maxFixRounds: 3 });
    const out = await runTask(
      "x [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE,CHANGES_REQUESTED,APPROVE reviewer=CHANGES_REQUESTED,APPROVE]]",
    );
    expect(out.kind).toBe("done");
    const findings = mockState.prompts.filter((p) => p.includes("## Findings ("));
    expect(
      findings.some(
        (p) =>
          p.includes("## Findings (observer round 3)") &&
          p.includes("- finding: mock issue observer round 3"),
      ),
    ).toBe(true);
    expect(findings.some((p) => p.includes("## Findings (observer round 2)"))).toBe(false);
    expect(findings.some((p) => p.includes("## Findings (reviewer round 1)"))).toBe(true);
  });

  it.each(["observer", "reviewer"] as const)(
    "%s system prompt keeps the worktree clean",
    async (role) => {
      expect(SYSTEM_PROMPTS[role]).toContain("temporary directory outside the working directory");
      expect(SYSTEM_PROMPTS[role]).toContain("Leave the working tree exactly as you found it");

      await withObserver();
      const seen: Record<string, string> = {};
      mockState.onRun = async (opts) => {
        seen[opts.role] = opts.systemPrompt;
      };
      const out = await runTask("x");
      expect(out.kind).toBe("done");
      expect(seen[role]).toContain("Leave the working tree exactly as you found it");
    },
  );

  it("unknown mock verdict token fails the task", async () => {
    const out = await runTask("x [[mock-verdicts reviewer=BOGUS]]");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toContain("unknown mock verdict token: BOGUS");
  });

  it("scripted verdict rounds restart each iteration (runs: 2)", async () => {
    await runTask("x [[mock-verdicts reviewer=CHANGES_REQUESTED,APPROVE]]", { runs: 2 });
    const second = await engine.tick();
    expect(second.kind).toBe("ran");
    const end = await store.get("t1");
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
    const done = await store.get("t1");
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
    const done = await store.get("t1");
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

describe("transient retries, stalls and prompts (mock tool)", () => {
  const MOCK = { tool: "mock", model: "mock-default" };
  const configure = async (over: {
    retries?: { transient?: number; backoffMs?: number[]; idleTimeoutMs?: number };
    observer?: boolean;
  }) => {
    const s = await engine.settingsStore.load();
    await engine.settingsStore.save({
      ...s,
      roles: { ...s.roles, ...(over.observer ? { observer: MOCK } : {}) },
      ...(over.retries
        ? {
            retries: {
              transient: 2,
              backoffMs: [0],
              idleTimeoutMs: 1200000,
              ...over.retries,
            },
          }
        : {}),
    });
  };
  const run = async (prompt: string, over: Partial<TaskFrontmatter> = {}) => {
    await store.create(newTask(fm(over), prompt));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    return r.outcome;
  };
  const devCalls = () => mockState.calls.filter((c) => c === "developer").length;

  it("one transient failure, then success: done, same worktree, retry logged, prompt amended", async () => {
    await configure({ retries: {} });
    const cwds: string[] = [];
    mockState.onRun = async (opts) => {
      if (opts.role === "developer") cwds.push(opts.cwd);
    };
    const outcome = await run("Build it. [[mock-transient developer=1]]");
    expect(outcome.kind).toBe("done");
    expect(devCalls()).toBe(2);
    expect(cwds).toEqual([wtPath(), wtPath()]);
    const devPrompts = mockState.prompts.filter((_, i) => mockState.calls[i] === "developer");
    expect(devPrompts[0]).not.toContain("## Previous attempt interrupted");
    expect(devPrompts[1]).toContain("## Previous attempt interrupted");
    expect(devPrompts[1]).toContain("git status");
    const done = await store.get("t1");
    expect(done?.body.log).toMatch(
      /Transient failure in Developer \(attempt 1\/2\): API Error: 503.*retrying in 0s in the same worktree/,
    );
  });

  it("retries exhausted: the task fails and the worktree is kept", async () => {
    await configure({ retries: { transient: 2 } });
    mockState.onRun = async (opts) => {
      if (opts.role === "planner") await writeIn(opts, "wip.txt");
    };
    const outcome = await run("Build it. [[mock-transient developer=3]]");
    expect(outcome.kind).toBe("failed");
    expect(devCalls()).toBe(3);
    expect(await exists(join(wtPath(), "wip.txt"))).toBe(true);
  });

  it("transient: 0 disables retries", async () => {
    await configure({ retries: { transient: 0 } });
    const outcome = await run("Build it. [[mock-transient developer=1]]");
    expect(outcome.kind).toBe("failed");
    expect(devCalls()).toBe(1);
  });

  it("a non-transient error is not retried", async () => {
    await configure({ retries: {} });
    mockState.failRole = "developer";
    const outcome = await run("Build it.");
    expect(outcome.kind).toBe("failed");
    expect(devCalls()).toBe(1);
  });

  it("a stop request during the backoff stops the task", async () => {
    await configure({ retries: { backoffMs: [60000] } });
    const poll = setInterval(() => {
      void readFile(join(workingAreaDir(projectDir, "t1"), "log.txt"), "utf8")
        .then(async (log) => {
          if (!log.includes("Transient failure")) return;
          await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
          await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");
        })
        .catch(() => {});
    }, 50);
    const started = Date.now();
    try {
      const outcome = await run("Build it. [[mock-transient developer=1]]");
      expect(outcome.kind).toBe("stopped");
    } finally {
      clearInterval(poll);
    }
    expect(Date.now() - started).toBeLessThan(8000);
    expect(devCalls()).toBe(1);
    expect(await exists(wtPath())).toBe(true);
  });

  it("a stalled tool is killed and retried as a transient failure", async () => {
    await configure({ retries: { idleTimeoutMs: 300 } });
    const outcome = await run("Build it. [[mock-stall developer=1]]");
    expect(outcome.kind).toBe("done");
    expect(devCalls()).toBe(2);
    expect((await store.get("t1"))?.body.log).toContain("stalled: no output");
  });

  it("every role's system prompt carries the non-interactive guard", async () => {
    await configure({ observer: true });
    mockState.roleQuestions = { developer: ["Which db?"] };
    const outcome = await run(
      "Build it. [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]",
    );
    expect(outcome.kind).toBe("done");
    const seen = new Map<string, Set<string>>();
    for (const { role, systemPrompt } of mockState.systemPrompts) {
      expect(systemPrompt).toContain(NON_INTERACTIVE);
      expect(systemPrompt).toContain("Never end your turn while waiting on background");
      const set = seen.get(role) ?? new Set<string>();
      set.add(systemPrompt);
      seen.set(role, set);
    }
    const all = [...seen.values()].flatMap((v) => [...v]);
    const has = (needle: string) => all.some((p) => p.includes(needle));
    expect(has("You are the PLANNER. Produce")).toBe(true);
    expect(has("PLANNER doing a refinement")).toBe(true);
    expect(has("You are the DEVELOPER. Implement")).toBe(true);
    expect(has("DEVELOPER fixing review findings")).toBe(true);
    expect(has("You are the OBSERVER")).toBe(true);
    expect(has("You are the REVIEWER")).toBe(true);
    expect(has("Answer the following questions")).toBe(true);
    for (const p of Object.values(SYSTEM_PROMPTS)) expect(p).toContain(NON_INTERACTIVE);
  });

  it("carried findings survive iteration 2 parking and resuming", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=APPROVE reviewer=APPROVE]]", { runs: 2 });
    mockState.plannerQuestions = ["Which db?"];
    const parked = await engine.tick();
    if (parked.kind === "ran") expect(parked.outcome.kind).toBe("parked");
    await store.transition("t1", "pending", (t) => {
      t.body.answers = "Postgres.";
      t.frontmatter.questions = "answered";
    });
    const from = mockState.prompts.length;
    await engine.tick();
    const resumed = mockState.prompts.slice(from);
    expect(resumed.length).toBeGreaterThan(0);
    for (const p of resumed) {
      expect(p).toContain("## Findings from the previous iteration");
      expect(p).toContain("### Reviewer (final report)");
    }
  });

  it("carried findings survive iteration 2 failing and being retried", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=APPROVE reviewer=APPROVE]]", { runs: 2 });
    mockState.failRole = "developer";
    const failed = await engine.tick();
    if (failed.kind === "ran") expect(failed.outcome.kind).toBe("failed");
    mockState.failRole = null;
    await store.transition("t1", "pending");
    const from = mockState.prompts.length;
    await engine.tick();
    const retried = mockState.prompts.slice(from);
    expect(retried.length).toBeGreaterThan(0);
    for (const p of retried) {
      expect(p).toContain("## Findings from the previous iteration");
      expect(p).toContain("### Reviewer (final report)");
    }
  });

  it("carried findings stay iteration 1's when iteration 2 fails after its observer round 1", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]", {
      runs: 2,
    });
    let failFix = true;
    mockState.onRun = async (opts) => {
      const observerCalls = mockState.calls.filter((c) => c === "observer").length;
      if (failFix && opts.role === "developer" && observerCalls >= 3) {
        throw new Error("boom after observer round 1 of iteration 2");
      }
    };
    const failed = await engine.tick();
    if (failed.kind === "ran") expect(failed.outcome.kind).toBe("failed");
    failFix = false;
    await store.transition("t1", "pending");
    const from = mockState.prompts.length;
    await engine.tick();
    const retried = mockState.prompts.slice(from);
    expect(retried.length).toBeGreaterThan(0);
    for (const p of retried) {
      expect(p).toContain("## Findings from the previous iteration");
      expect(p).toContain("#### Round 2 — APPROVE");
      expect(p).not.toContain("#### Round 1 — CHANGES_REQUESTED");
    }
  });

  it("runs > 1: iteration 2 prompts carry iteration 1's final observer and reviewer reports", async () => {
    await configure({ observer: true });
    await run("Twice. [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]", {
      runs: 2,
    });
    await engine.tick();
    const heading = "## Findings from the previous iteration";
    const iter2 = mockState.prompts.filter((p) => p.includes("## Iteration 2 of 2"));
    const iter1 = mockState.prompts.filter((p) => !p.includes("## Iteration 2 of 2"));
    expect(iter1.length).toBeGreaterThan(0);
    expect(iter2.length).toBeGreaterThan(0);
    for (const p of iter1) expect(p).not.toContain(heading);
    for (const p of iter2) {
      const from = p.indexOf(heading);
      const next = p.indexOf("\n\n## ", from + heading.length);
      const section = p.slice(from, next === -1 ? undefined : next);
      expect(p).toContain(heading);
      expect(section).toContain("### Observer (final report)");
      expect(section).toContain("### Reviewer (final report)");
      expect(section).toContain("#### Round 2 — APPROVE");
      expect(section).toContain("VERDICT: APPROVE");
      // Only the final round, not the earlier CHANGES_REQUESTED one.
      expect(section).not.toContain("mock issue observer round 1");
    }
  });
});

/** A second (and third) registered repository for the multi-project tests. */
interface Extra {
  project: Project;
  repo: string;
  dir: string;
  store: TaskStore;
}
const extraRepos: string[] = [];

async function addProject(id: string): Promise<Extra> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), `boof-runner-${id}-`)));
  extraRepos.push(repo);
  const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(repo, "README.md"), `# ${id}\n`);
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
  const projects = new ProjectStore(dataRoot);
  const created = await projects.create({ workingDirectory: repo, id });
  return { project: created, repo, dir: projects.dir(id), store: new TaskStore(projects.dir(id)) };
}

afterEach(async () => {
  for (const r of extraRepos.splice(0))
    await rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A task that takes its roles from settings instead of a per-task override. */
const withoutTools = (f: TaskFrontmatter): TaskFrontmatter => {
  const { tools: _tools, ...rest } = f;
  void _tools;
  return rest;
};

/** Ids in run order, as `project/task`. */
const order = (results: Awaited<ReturnType<RunnerEngine["runUntilIdle"]>>) =>
  results.flatMap((r) =>
    r.kind === "ran" ? [`${r.projectId}/${r.outcome.task.frontmatter.id}`] : [],
  );

describe("steering a running step (mock tool)", () => {
  const STEER_TEXT = "use tabs, not spaces";
  const liveLog = () =>
    readFile(join(workingAreaDir(projectDir, "t1"), "log.txt"), "utf8").catch(() => "");
  const devHeaders = (log: string) =>
    (log.match(/^### Developer( \(steer \d+\))?$/gm) ?? []).length;
  const devCalls = () => mockState.calls.filter((c) => c === "developer").length;

  /** What the inject API does for mode `now`: durable entry, prompts.md and the steer request. */
  const requestSteer = async (text: string) => {
    await store.appendInjected("t1", text, "user", "now");
    await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
    await appendFile(taskPromptInjectionsPath(projectDir, "t1"), `\n\n## now\n${text}\n`);
    await appendFile(
      taskSteerRequestPath(projectDir, "t1"),
      JSON.stringify({ at: new Date().toISOString(), text }) + "\n",
    );
  };

  /**
   * Run `fn` every 40 ms, like a user acting on the task. The returned stop clears the timer and
   * waits for the ticks still in flight: a tick is a few awaited file writes, and one that outlives
   * the test would write into the task directory while the afterEach cleanup removes it (ENOTEMPTY).
   */
  const poll = (fn: () => Promise<void>) => {
    const inflight = new Set<Promise<void>>();
    const timer = setInterval(() => {
      const tick = fn().catch(() => {});
      inflight.add(tick);
      void tick.finally(() => inflight.delete(tick));
    }, 40);
    return async () => {
      clearInterval(timer);
      await Promise.all([...inflight]);
    };
  };

  /** Steer `times` times, each once a fresh Developer attempt has started and the last steer is gone. */
  const steerDeveloper = (times: number) => {
    let sent = 0;
    return poll(async () => {
      if (sent >= times || existsSync(taskSteerRequestPath(projectDir, "t1"))) return;
      if (devHeaders(await liveLog()) !== sent + 1) return;
      sent++;
      await requestSteer(sent === 1 ? STEER_TEXT : `${STEER_TEXT} ${sent}`);
    });
  };

  const runTask = async (prompt: string) => {
    await store.create(newTask(fm(), prompt));
    const r = await engine.tick();
    if (r.kind !== "ran") throw new Error(`expected ran, got ${r.kind}`);
    return r.outcome;
  };

  it("kills the running step, resumes its session with the new prompt and finishes", async () => {
    const stop = steerDeveloper(1);
    let outcome;
    try {
      outcome = await runTask("Build it. [[mock-stall developer=1]]");
    } finally {
      await stop();
    }
    expect(outcome.kind).toBe("done");
    expect(devCalls()).toBe(2);
    expect(mockState.resumes).toHaveLength(1);
    const resumed = mockState.resumes[0]!;
    expect(resumed.role).toBe("developer");
    expect(resumed.sessionId).toMatch(/^mock-session-\d+$/);
    expect(resumed.prompt).toBe(
      "The user sent new instructions while you were working. Continue the same task from where " +
        `you stopped and apply them:\n\n${STEER_TEXT}`,
    );
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain(`### Steered\n${STEER_TEXT}`);
    expect(done.body.log).toContain("### Developer (steer 1)");
    // The interrupted attempt is counted: planner, refinement, developer x2 and reviewer.
    expect(done.frontmatter.tokens?.costUsd).toBeCloseTo(0.05);
    // The control request is consumed and the durable entry records mode and application.
    expect(await exists(taskSteerRequestPath(projectDir, "t1"))).toBe(false);
    const [entry] = parseInjected(done.body.injected);
    expect(entry?.mode).toBe("now");
    expect(entry?.appliedAt).toBeTruthy();
  });

  it("a tool that cannot resume restarts the step with its prompt, the new text and the interruption note", async () => {
    mockState.resumeSupported = false;
    const stop = steerDeveloper(1);
    try {
      const outcome = await runTask("Build it. [[mock-stall developer=1]]");
      expect(outcome.kind).toBe("done");
    } finally {
      await stop();
    }
    expect(mockState.resumes).toHaveLength(0);
    const devPrompts = mockState.prompts.filter((_, i) => mockState.calls[i] === "developer");
    expect(devPrompts).toHaveLength(2);
    expect(devPrompts[1]).toContain("Build it.");
    expect(devPrompts[1]).toContain("## Plan");
    expect(devPrompts[1]).toContain(STEER_TEXT);
    expect(devPrompts[1]).toContain("## Previous attempt interrupted");
    expect(devPrompts[1]).toContain("git status");
    expect(devPrompts[0]).not.toContain("## Previous attempt interrupted");
  });

  it("steers do not use the transient retry budget", async () => {
    await engine.settingsStore.update({ retries: { transient: 0 } });
    mockState.resumeSupported = false;
    const stop = steerDeveloper(2);
    try {
      const outcome = await runTask("Build it. [[mock-stall developer=2]]");
      expect(outcome.kind).toBe("done");
    } finally {
      await stop();
    }
    expect(devCalls()).toBe(3);
  });

  it("stops steering one step after the cap; later prompts wait for the next step", async () => {
    mockState.resumeSupported = false;
    // The 6th run stalls with no steer path and is cut by the idle watchdog, then retried.
    await engine.settingsStore.update({
      retries: { transient: 2, backoffMs: [0], idleTimeoutMs: 1500 },
    });
    const stop = steerDeveloper(6);
    let outcome;
    try {
      outcome = await runTask("Build it. [[mock-stall developer=6]]");
    } finally {
      await stop();
    }
    expect(outcome.kind === "failed" ? outcome.error : outcome.kind).toBe("done");
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain("Steer limit reached for Developer (5)");
    expect(done.body.log).toContain("### Developer (steer 5)");
    expect(done.body.log).not.toContain("### Developer (steer 6)");
    // 5 steered runs, the stalled sixth, its transient retry.
    expect(devCalls()).toBe(7);
  }, 30000);

  it("a steer that arrives between steps applies to the next step without a kill", async () => {
    let first = true;
    mockState.onRun = async (opts) => {
      if (opts.role === "planner" && first) {
        first = false;
        await requestSteer(STEER_TEXT);
      }
    };
    const outcome = await runTask("Build it.");
    expect(outcome.kind).toBe("done");
    expect(mockState.calls).toEqual(["planner", "planner", "developer", "reviewer"]);
    expect(mockState.resumes).toHaveLength(0);
    const refine = mockState.prompts[1]!;
    expect(refine).toContain(STEER_TEXT);
    // Injected once: the prompt already carried it from prompts.md.
    expect(refine.split(STEER_TEXT)).toHaveLength(2);
    const done = (await store.get("t1"))!;
    expect(done.body.log).toContain(`### Steered\n${STEER_TEXT}`);
    expect(await exists(taskSteerRequestPath(projectDir, "t1"))).toBe(false);
    expect(parseInjected(done.body.injected)[0]?.appliedAt).toBeTruthy();
  });

  it("a stop request wins over a steer", async () => {
    let sent = false;
    const stop = poll(async () => {
      if (sent || devHeaders(await liveLog()) !== 1) return;
      sent = true;
      await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
      await writeFile(taskStopRequestPath(projectDir, "t1"), "stop\n");
      await requestSteer(STEER_TEXT);
    });
    try {
      const outcome = await runTask("Build it. [[mock-stall developer=1]]");
      expect(outcome.kind).toBe("stopped");
    } finally {
      await stop();
    }
    expect(devCalls()).toBe(1);
  });
});

describe("multi-project engine (mock tool)", () => {
  it("serves projects in global priority order, interleaved", async () => {
    const b = await addProject("b");
    await store.create(newTask(fm({ id: "a-low", priority: 10 }), "a low"));
    await store.create(newTask(fm({ id: "a-mid", priority: 50 }), "a mid"));
    await b.store.create(newTask(fm({ id: "b-high", priority: 90 }), "b high"));
    await b.store.create(newTask(fm({ id: "b-mid", priority: 30 }), "b mid"));

    expect(order(await engine.runUntilIdle())).toEqual([
      "b/b-high",
      "default/a-mid",
      "b/b-mid",
      "default/a-low",
    ]);
    expect((await b.store.get("b-high"))?.frontmatter.status).toBe("done");
    expect((await store.get("a-mid"))?.frontmatter.status).toBe("done");
  });

  it("breaks priority ties by oldest `updated`, then by project id, then by task id", async () => {
    const b = await addProject("b");
    const write = (dir: string, id: string, updated: string) =>
      writeFile(
        taskFilePath(dir, "pending", id),
        serializeTask(newTask(fm({ id, priority: 50, updated }), id)),
      );
    await write(projectDir, "newer", "2026-06-04T10:00:05.000Z");
    await write(b.dir, "older", "2026-06-04T10:00:01.000Z");
    // Identical priority and `updated`: project id, then task id decide.
    await write(projectDir, "same-b", "2026-06-04T10:00:09.000Z");
    await write(projectDir, "same-a", "2026-06-04T10:00:09.000Z");
    await write(b.dir, "same-c", "2026-06-04T10:00:09.000Z");

    expect(order(await engine.runUntilIdle())).toEqual([
      "b/older",
      "default/newer",
      "b/same-c", // project "b" sorts before "default"
      "default/same-a",
      "default/same-b",
    ]);
  });

  it("skips paused, archived and directory-less projects, and serves them again once resumed", async () => {
    const b = await addProject("b");
    await b.store.create(newTask(fm({ id: "b1", priority: 99 }), "b1"));
    await store.create(newTask(fm({ id: "a1", priority: 1 }), "a1"));

    await new ProjectStore(dataRoot).update("b", { paused: true });
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("a1");
    await new ProjectStore(dataRoot).update("b", { paused: false, archived: true });
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("a1");
    await new ProjectStore(dataRoot).update("b", { archived: false });
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("b1");

    // A migrated project without a working directory is not runnable.
    await writeFile(
      join(b.dir, "project.json"),
      JSON.stringify({ ...b.project, workingDirectory: "" }),
    );
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("a1");

    expect(order(await engine.runUntilIdle())).toEqual(["default/a1"]);
    expect((await b.store.get("b1"))?.frontmatter.status).toBe("pending");
  });

  it("onlyProject restricts the engine to one project", async () => {
    const b = await addProject("b");
    await b.store.create(newTask(fm({ id: "b1", priority: 99 }), "b1"));
    await store.create(newTask(fm({ id: "a1", priority: 1 }), "a1"));
    const only = new RunnerEngine({ root: dataRoot, onlyProject: "default" });
    expect(order(await only.runUntilIdle())).toEqual(["default/a1"]);
  });

  it("bumpGoalFile writes into the repository of the project the task belongs to", async () => {
    const b = await addProject("b");
    const goalXml = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>${name}</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;
    for (const repo of [workDir, b.repo]) {
      await mkdir(join(repo, "core"), { recursive: true });
      await writeFile(join(repo, "core", "goal.boof.xml"), goalXml("core"), "utf8");
    }
    // The same relative path in both repos; only project b's task completes.
    await b.store.create(
      newTask(fm({ id: "bt", boofGoal: { path: "core/goal.boof.xml", bumpTo: "done" } }), "b"),
    );
    expect(order(await engine.runUntilIdle())).toEqual(["b/bt"]);

    const read = async (repo: string) =>
      parseGoal(await readFile(join(repo, "core", "goal.boof.xml"), "utf8"));
    expect(currentStatus(await read(b.repo))).toBe("done");
    expect(currentStatus(await read(workDir))).toBe("plan");
  });

  it("honours a per-project worktree root override and project-level role overrides", async () => {
    const b = await addProject("b");
    const wtRoot = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-wt-")));
    extraRepos.push(wtRoot);
    await new ProjectStore(dataRoot).update("b", {
      worktree: { root: wtRoot },
      roles: { developer: { tool: "mock", model: "project-dev" } },
    });
    const cwds: string[] = [];
    const models: string[] = [];
    mockState.onRun = async (opts) => {
      cwds.push(opts.cwd);
      if (opts.role === "developer") models.push(opts.model);
    };
    // No per-task tools: roles come from global settings + the project's override.
    await engine.settingsStore.update({
      roles: {
        planner: { tool: "mock", model: "g-plan" },
        developer: { tool: "mock", model: "g-dev" },
        reviewer: { tool: "mock", model: "g-rev" },
      },
    });
    await b.store.create(newTask(withoutTools(fm({ id: "bt" })), "b"));
    await store.create(newTask(withoutTools(fm({ id: "at", priority: 10 })), "a"));
    expect(order(await engine.runUntilIdle())).toEqual(["b/bt", "default/at"]);

    const bCwds = cwds.filter((c) => c.startsWith(`${wtRoot}/`));
    const aCwds = cwds.filter((c) => c.startsWith(`${workDir}/.boof-runner-worktrees/`));
    expect(bCwds.length).toBeGreaterThan(0);
    expect(aCwds.length).toBeGreaterThan(0);
    expect(bCwds.length + aCwds.length).toBe(cwds.length);
    expect(models).toEqual(["project-dev", "g-dev"]);
  });

  /** Tracks how many roles run at once per repository and overall, with a delay in every step. */
  const trackConcurrency = (repos: string[]) => {
    const active = new Map<string, number>();
    const maxPerRepo = new Map<string, number>();
    let activeTotal = 0;
    let maxTotal = 0;
    mockState.onRun = async (opts) => {
      const repo = repos.find((r) => opts.cwd.startsWith(`${r}/`)) ?? "?";
      const n = (active.get(repo) ?? 0) + 1;
      active.set(repo, n);
      maxPerRepo.set(repo, Math.max(maxPerRepo.get(repo) ?? 0, n));
      activeTotal += 1;
      maxTotal = Math.max(maxTotal, activeTotal);
      await new Promise((r) => setTimeout(r, 25));
      active.set(repo, (active.get(repo) ?? 1) - 1);
      activeTotal -= 1;
    };
    return { maxPerRepo, maxTotal: () => maxTotal };
  };

  it("concurrency=2 runs two projects at once but never two tasks of one project", async () => {
    const b = await addProject("b");
    await engine.settingsStore.update({ runner: { concurrency: 2 } });
    for (const [s, label] of [
      [store, "a"],
      [b.store, "b"],
    ] as const) {
      await s.create(newTask(fm({ id: `${label}1`, priority: 50 }), `${label}1`));
      await s.create(newTask(fm({ id: `${label}2`, priority: 40 }), `${label}2`));
    }
    const track = trackConcurrency([workDir, b.repo]);

    const results = await engine.runUntilIdle();
    expect(order(results).sort()).toEqual(["b/b1", "b/b2", "default/a1", "default/a2"]);
    expect(track.maxTotal()).toBe(2); // two projects overlapped
    expect(track.maxPerRepo.get(workDir)).toBe(1); // never two steps of one project at once
    expect(track.maxPerRepo.get(b.repo)).toBe(1);
    for (const id of ["a1", "a2"]) expect((await store.get(id))?.frontmatter.status).toBe("done");
    for (const id of ["b1", "b2"]) expect((await b.store.get(id))?.frontmatter.status).toBe("done");
  });

  it("concurrency=2 with a single project still runs its tasks one after the other", async () => {
    await engine.settingsStore.update({ runner: { concurrency: 2 } });
    await store.create(newTask(fm({ id: "t1", priority: 50 }), "t1"));
    await store.create(newTask(fm({ id: "t2", priority: 40 }), "t2"));
    const track = trackConcurrency([workDir]);

    expect(order(await engine.runUntilIdle())).toEqual(["default/t1", "default/t2"]);
    expect(track.maxTotal()).toBe(1);
  });

  it("selectNext skips a project that has a task in flight", async () => {
    await engine.settingsStore.update({ runner: { concurrency: 2 } });
    await store.create(newTask(fm({ id: "t1", priority: 50 }), "t1"));
    await store.create(newTask(fm({ id: "t2", priority: 40 }), "t2"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    mockState.onRun = async () => {
      started();
      await gate;
    };
    const first = engine.tick();
    await running;
    expect(await engine.selectNext()).toBeNull(); // t2 waits: its project is busy
    release();
    expect((await first).kind).toBe("ran");
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("t2");
  });

  it("loop() drains two projects and stops cooperatively", async () => {
    const b = await addProject("b");
    await store.create(newTask(fm({ id: "a1" }), "a1"));
    await b.store.create(newTask(fm({ id: "b1" }), "b1"));
    const done = engine.loop();
    for (let i = 0; i < 400; i += 1) {
      const a = await store.get("a1");
      const c = await b.store.get("b1");
      if (a?.frontmatter.status === "done" && c?.frontmatter.status === "done") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    engine.stop();
    await done;
    expect((await store.get("a1"))?.frontmatter.status).toBe("done");
    expect((await b.store.get("b1"))?.frontmatter.status).toBe("done");
  });
});

describe("stopped status and durable injected prompts (mock tool)", () => {
  /** First planner call: inject a prompt (as the API does) and request a stop. */
  const stopDuringPlanner = (note?: string) => {
    let first = true;
    mockState.onRun = async () => {
      if (!first) return;
      first = false;
      await store.appendInjected("t1", "use tabs, not spaces", "alice");
      await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
      await writeFile(taskStopRequestPath(projectDir, "t1"), note ?? "stop\n");
    };
  };

  it("a user stop records the task as stopped, keeps the worktree and the injected prompt", async () => {
    stopDuringPlanner();
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("stopped");

    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("stopped");
    expect(await exists(taskFilePath(projectDir, "stopped", "t1"))).toBe(true);
    expect(await exists(workingAreaDir(projectDir, "t1"))).toBe(false);
    expect(t?.body.log).toContain("### Stopped\nstopped by user");
    expect(await exists(wtPath())).toBe(true);
    expect(await exists(join(taskControlDir(projectDir, "t1"), "prompts.md"))).toBe(false);
    expect(t?.body.injected).toContain("alice");
    expect(t?.body.injected).toContain("use tabs, not spaces");
    const events = (await readFile(join(projectDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ type: "task.status", from: "running", to: "stopped" });
  });

  it("retrying a stopped task continues in the same worktree and re-states the injected prompt", async () => {
    stopDuringPlanner();
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    await writeFile(join(wtPath(), "wip.txt"), "wip\n");
    expect((await store.get("t1"))?.frontmatter.status).toBe("stopped");

    mockState.prompts = [];
    const cwds: string[] = [];
    mockState.onRun = async (opts) => void cwds.push(opts.cwd);
    await store.transition("t1", "pending");
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("done");

    expect(cwds.every((c) => c === wtPath())).toBe(true);
    const first = mockState.prompts[0];
    expect(first).toContain("## Previous run stopped");
    expect(first).toContain("git status");
    expect(first).toContain("## Earlier injected instructions");
    expect(first).toContain("use tabs, not spaces");
    // The injected prompts stay on the finished task.
    expect((await store.get("t1"))?.body.injected).toContain("use tabs, not spaces");
  });

  it("a later retry after a completed run no longer says the run was stopped", async () => {
    stopDuringPlanner();
    await store.create(newTask(fm({ runs: 2 }), "Build it."));
    await engine.tick();
    await store.transition("t1", "pending");
    await engine.tick(); // iteration 1 completes, task re-queued for iteration 2
    mockState.prompts = [];
    mockState.onRun = null;
    await engine.tick();
    expect(mockState.prompts[0]).not.toContain("## Previous run stopped");
  });

  it("server shutdown records the task as stopped with a shutdown note", async () => {
    let started!: () => void;
    const up = new Promise<void>((r) => (started = r));
    mockState.onRun = async (opts) => {
      started();
      // Wait for the stop request like a real tool would, then fail as a stopped tool.
      for (let i = 0; i < 400; i++) {
        if (opts.stopSignalPath && (await exists(opts.stopSignalPath))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new ToolRunError("mock", null, false, true, "stopped", "");
    };
    await store.create(newTask(fm(), "Build it."));
    const loop = engine.loop();
    await up;
    await engine.shutdown(10000);
    await loop;
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("stopped");
    expect(t?.body.log).toContain("### Stopped\nstopped by server shutdown");
  });

  it("a failed run still ends as failed, with its injected prompt kept", async () => {
    mockState.onRun = async () => {
      await store.appendInjected("t1", "be careful");
    };
    mockState.failRole = "developer";
    await store.create(newTask(fm(), "Build it."));
    const r = await engine.tick();
    expect(r.kind === "ran" && r.outcome.kind).toBe("failed");
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("failed");
    expect(t?.body.injected).toContain("be careful");
    expect(t?.body.injected).toContain("user");
  });

  it("a done run keeps its injected prompts", async () => {
    mockState.onRun = async () => {
      if (!(await store.get("t1"))?.body.injected) await store.appendInjected("t1", "one", "bot");
    };
    await store.create(newTask(fm(), "Build it."));
    await engine.tick();
    const t = await store.get("t1");
    expect(t?.frontmatter.status).toBe("done");
    expect(t?.body.injected).toContain("bot");
  });
});

describe("RunnerEngine.shutdown (SIGTERM under systemd)", () => {
  it("stops the running task, kills the agent process group and leaves the task stopped (retryable)", async () => {
    await store.create(newTask(fm(), "Long job."));
    const pidFile = join(dataRoot, "agent.pid");
    let started!: () => void;
    const up = new Promise<void>((r) => (started = r));
    mockState.onRun = async (opts) => {
      // A stand-in agent: a shell that spawns a grandchild and waits for it.
      const watch = setInterval(() => {
        if (existsSync(pidFile)) {
          clearInterval(watch);
          started();
        }
      }, 20);
      const res = await execCommand("sh", ["-c", `sleep 300 & echo $! > "${pidFile}"; wait`], {
        cwd: opts.cwd,
        stopSignalPath: opts.stopSignalPath,
        stopPollMs: 25,
      });
      clearInterval(watch);
      throw new ToolRunError("mock", res.code, res.timedOut, res.stopped, "stopped", res.stderr);
    };
    const loop = engine.loop();
    await up;
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    expect(() => process.kill(grandchild, 0)).not.toThrow();

    const result = await engine.shutdown(15000);
    expect(result).toEqual({ stopped: ["t1"], timedOut: false });
    await loop;

    const after = await store.get("t1");
    expect(after?.frontmatter.status).toBe("stopped");
    expect(after?.body.log).toContain("stopped by server shutdown");
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(grandchild, 0)).toThrow(); // not orphaned
    // stopped -> pending is a legal transition, so the task can be retried after a restart.
    await store.transition("t1", "pending");
    expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
  });

  it("returns at once when nothing is running", async () => {
    expect(await engine.shutdown(1000)).toEqual({ stopped: [], timedOut: false });
  });

  afterEach(() => vi.restoreAllMocks());

  it("a shutdown that lands during selection starts nothing", async () => {
    await store.create(newTask(fm(), "Build it."));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let selecting!: () => void;
    const inSelect = new Promise<void>((r) => (selecting = r));
    const target = engine as unknown as { selectWithBudget: () => Promise<unknown> };
    const original = target.selectWithBudget.bind(engine);
    vi.spyOn(target, "selectWithBudget").mockImplementationOnce(async () => {
      selecting();
      await gate;
      return original();
    });
    const looping = engine.loop();
    await inSelect;
    const down = engine.shutdown(5000);
    release();
    expect(await down).toEqual({ stopped: [], timedOut: false });
    await looping;
    expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
    expect(mockState.calls).toEqual([]);
    expect(await exists(taskStopRequestPath(projectDir, "t1"))).toBe(false);
  });

  it("asks a task that starts while it drains to stop as well", async () => {
    const b = await addProject("b");
    await store.create(newTask(fm({ id: "a1" }), "a"));
    await b.store.create(newTask(fm({ id: "b1" }), "b"));
    const gate = () => {
      let open!: () => void;
      const wait = new Promise<void>((r) => (open = r));
      return { wait, open };
    };
    const started = { a1: gate(), b1: gate() };
    const go = { a1: gate(), b1: gate() };
    mockState.onRun = async (opts) => {
      if (opts.role !== "planner") return;
      const id = basename(opts.cwd) as "a1" | "b1";
      started[id].open();
      await go[id].wait;
    };
    const runA = engine.tick(); // a1 runs, its planner held open
    await started.a1.wait;
    const down = engine.shutdown(10_000); // asks a1 to stop, then waits for the drain
    const runB = engine.tick(); // tick() has no stop check: b1 starts after the shutdown began
    await started.b1.wait;
    go.a1.open();
    expect((await runA).kind).toBe("ran");
    await vi.waitFor(() => expect(existsSync(taskStopRequestPath(b.dir, "b1"))).toBe(true), {
      timeout: 5000,
    });
    go.b1.open();
    expect((await runB).kind).toBe("ran");
    expect(await down).toEqual({ stopped: ["a1", "b1"], timedOut: false });
    expect((await store.get("a1"))?.frontmatter.status).toBe("stopped");
    expect((await b.store.get("b1"))?.frontmatter.status).toBe("stopped");
    expect((await b.store.get("b1"))?.body.log).toContain("stopped by server shutdown");
  });

  describe("recovery of interrupted tasks", () => {
    /** A task a dead runner left in running: worktree, live log, no pipeline driving it. */
    const crash = async (id = "t1", withLog = true) => {
      await store.create(newTask(fm({ id }), "Build it."));
      await store.transition(id, "running");
      await ensureWorktree(workDir, id, { root: join(workDir, ".boof-runner-worktrees") });
      if (withLog) {
        await mkdir(workingAreaDir(projectDir, id), { recursive: true });
        await writeFile(join(workingAreaDir(projectDir, id), "log.txt"), "live output line\n");
      }
    };
    const loopBriefly = async () => {
      const done = engine.loop();
      await new Promise((r) => setTimeout(r, 150));
      engine.stop();
      await done;
    };

    it("fails a task left running, keeps the worktree, and allows a retry", async () => {
      await crash();
      await loopBriefly();
      const t = await store.get("t1");
      expect(t?.frontmatter.status).toBe("failed");
      expect(t?.body.log).toContain("live output line");
      expect(t?.body.log).toContain("### Interrupted\nThe runner stopped unexpectedly");
      expect(await exists(wtPath())).toBe(true);
      expect(await exists(workingAreaDir(projectDir, "t1"))).toBe(false);
      const events = (await readFile(join(projectDir, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(events.at(-1)).toMatchObject({
        type: "task.status",
        task: "t1",
        from: "running",
        to: "failed",
        by: "runner",
      });
      expect(events.at(-1).reason).toContain("interrupted");

      await store.transition("t1", "pending");
      expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
    });

    it("is idempotent: a second start recovers nothing", async () => {
      await crash();
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      const before = (await store.get("t1"))?.body.log;
      expect(await engine.recoverInterrupted()).toEqual([]);
      expect((await store.get("t1"))?.body.log).toBe(before);
      expect(before?.match(/### Interrupted/g)).toHaveLength(1);
    });

    it("recovers a task with no log.txt and skips an entry with no task.md", async () => {
      await crash("t1", false);
      await mkdir(workingAreaDir(projectDir, "ghost"), { recursive: true });
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      expect((await store.get("t1"))?.frontmatter.status).toBe("failed");
      expect(await exists(workingAreaDir(projectDir, "ghost"))).toBe(true);
    });

    it("does nothing when no engine loop runs (the --no-runner path)", async () => {
      await crash();
      expect((await store.get("t1"))?.frontmatter.status).toBe("running");
    });
  });
});
