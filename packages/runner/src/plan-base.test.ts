import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  PlanStore,
  ProjectStore,
  SettingsStore,
  TaskStore,
  testGoal,
  type Goal,
} from "@boof-runner/shared";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { createIntegrationBranch } from "./plan-base.js";
import { mockState, resetMock } from "./tools/mock.js";

let dataRoot: string;
let workDir: string;
let projectDir: string;
let tasks: TaskStore;
let plans: PlanStore;

const mock = { tool: "mock", model: "mock-default" };
const git = (args: string[], cwd = workDir) => execCommand("git", args, { cwd, timeoutMs: 20000 });

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-base-data-"));
  workDir = await realpath(await mkdtemp(join(tmpdir(), "boof-base-work-")));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@e.com"]);
  await git(["config", "user.name", "T"]);
  await writeFile(join(workDir, "README.md"), "# work\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  await new SettingsStore(dataRoot).save({
    ...defaultSettings(),
    runner: { enabled: true, concurrency: 1 },
    defaultProject: "default",
    roles: {
      planner: mock,
      developer: mock,
      observer: mock,
      reviewer: mock,
    },
  });
  const projects = new ProjectStore(dataRoot);
  await projects.create({ workingDirectory: workDir, id: "default" });
  projectDir = projects.dir("default");
  tasks = new TaskStore(projectDir);
  plans = new PlanStore(projectDir);
  resetMock();
  // The mock developer commits a file in the task worktree: `<goal>.txt`, or `same.txt` for goals named x*.
  mockState.onRun = async (opts) => {
    if (opts.role !== "developer") return;
    const goalId = /- Goal: (\S+)/.exec(opts.prompt)?.[1];
    if (!goalId) return;
    const conflicting = goalId.startsWith("x");
    await writeFile(join(opts.cwd, conflicting ? "same.txt" : `${goalId}.txt`), `${goalId}\n`);
    await git(["add", "-A"], opts.cwd);
    await git(["commit", "-m", `work for ${goalId}`], opts.cwd);
  };
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

async function runPlan(goals: Goal[]): Promise<void> {
  await plans.create({
    id: "p",
    title: "P",
    status: "active",
    autoSync: true,
    source: { kind: "api" },
    goals,
  });
  await new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 }).runUntilIdle();
}

const task = async (id: string) => (await tasks.get(id))!;
const isAncestor = async (a: string, b: string) =>
  (await git(["merge-base", "--is-ancestor", a, b])).code === 0;
const fileOn = async (branch: string, file: string) =>
  (await git(["cat-file", "-e", `${branch}:${file}`])).code === 0;

describe("a dependent goal starts from the branches of its dependencies", () => {
  it("one dependency: base is that branch and the new branch contains its work", async () => {
    await runPlan([testGoal("posts", 1), testGoal("rss", 2, ["posts"]), testGoal("about", 3)]);
    expect((await task("boof-rss")).frontmatter.status).toBe("done");
    expect((await task("boof-rss")).frontmatter.base).toBe("boof-runner/boof-posts");
    expect((await task("boof-rss")).body.log).toContain("Base: boof-runner/boof-posts");
    expect((await task("boof-rss")).body.log).toContain("goal posts");
    expect((await task("boof-posts")).frontmatter.base).toBeUndefined();
    expect(await isAncestor("boof-runner/boof-posts", "boof-runner/boof-rss")).toBe(true);
    expect(await fileOn("boof-runner/boof-rss", "posts.txt")).toBe(true);
    expect(await fileOn("boof-runner/boof-about", "posts.txt")).toBe(false);
    expect((await task("boof-rss")).body.prompt).not.toContain("## Dependencies");
  });

  it("two dependencies: an integration branch merges both; the user's checkout is untouched", async () => {
    await runPlan([testGoal("a", 1), testGoal("b", 2), testGoal("c", 3, ["a", "b"])]);
    const c = await task("boof-c");
    expect(c.frontmatter.status).toBe("done");
    expect(c.frontmatter.base).toBe("boof-runner/boof-c--base");
    expect(c.body.log).toContain(
      "boof-runner/boof-c--base (merge of boof-runner/boof-a (goal a), boof-runner/boof-b (goal b))",
    );
    expect(await fileOn("boof-runner/boof-c--base", "a.txt")).toBe(true);
    expect(await fileOn("boof-runner/boof-c--base", "b.txt")).toBe(true);
    expect(await fileOn("boof-runner/boof-c", "a.txt")).toBe(true);
    expect(await fileOn("boof-runner/boof-c", "b.txt")).toBe(true);
    expect(c.body.prompt).not.toContain("## Dependencies");
    // The user's branch, index and working tree are untouched; no temporary worktree is left.
    expect((await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("main");
    expect((await git(["status", "--porcelain"])).stdout.trim()).not.toContain("a.txt");
    expect((await git(["log", "--oneline", "main"])).stdout.trim().split("\n")).toHaveLength(1);
    expect((await git(["worktree", "list"])).stdout).not.toContain("boof-integration");
  });

  it("two conflicting dependencies: no integration branch; first dependency is the base; the prompt lists the other", async () => {
    await runPlan([testGoal("xa", 1), testGoal("xb", 2), testGoal("c", 3, ["xa", "xb"])]);
    const c = await task("boof-c");
    expect(c.frontmatter.base).toBe("boof-runner/boof-xa");
    expect(c.body.prompt).toContain("## Dependencies");
    expect(c.body.prompt).toContain("git merge");
    expect(c.body.prompt).toContain("- boof-runner/boof-xb");
    expect(c.body.log).toContain(
      "no integration branch because merging boof-runner/boof-xb conflicts",
    );
    expect(
      (await git(["rev-parse", "--verify", "--quiet", "refs/heads/boof-runner/boof-c--base"])).code,
    ).not.toBe(0);
    expect((await git(["worktree", "list"])).stdout).not.toContain("boof-integration");
    expect((await git(["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("createIntegrationBranch refuses fewer than two branches", async () => {
    const res = await createIntegrationBranch(workDir, "x--base", ["main"]);
    expect(res.ok).toBe(false);
  });
});
