import { cp, mkdtemp, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import {
  defaultSettings,
  ProjectStore,
  SettingsStore,
  TaskStore,
  type Project,
  type TaskFrontmatter,
  resetSandboxStatus,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "@boof/heart";
import { resetMock } from "./tools/mock.js";
import type { RunOptions } from "./tools/types.js";

// Shared setup for the engine test files. One file of 140 tests could not run in parallel, so the
// engine tests are split by topic; each file calls useEngineRig() to get the same fixtures.

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;
/** The project under test: `workDir` registered as project `default`. */
let project: Project;
let projectDir: string;
let store: TaskStore;

export const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export const wtPath = (id = "t1") => join(workDir, ".boof-runner-worktrees", id);
export const gitOut = (args: string[], cwd = workDir) =>
  execCommand("git", args, { launch: { kind: "direct" }, cwd, timeoutMs: 15000 });
export const writeIn = (opts: RunOptions, file: string, content = "x\n") =>
  writeFile(join(opts.cwd, file), content);
export const commitIn = async (opts: RunOptions, file: string) => {
  await writeIn(opts, file);
  await gitOut(["add", file], opts.cwd);
  await gitOut(["commit", "-m", "agent"], opts.cwd);
};

export const fm = (over: Partial<TaskFrontmatter> = {}) =>
  ({
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
  }) as TaskFrontmatter;

/** A second (and third) registered repository for the multi-project tests. */
export interface Extra {
  project: Project;
  repo: string;
  dir: string;
  store: TaskStore;
}
export const extraRepos: string[] = [];

export async function addProject(id: string): Promise<Extra> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), `boof-runner-${id}-`)));
  extraRepos.push(repo);
  const g = (args: string[]) =>
    execCommand("git", args, { launch: { kind: "direct" }, cwd: repo, timeoutMs: 15000 });
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

/** A task that takes its roles from settings instead of a per-task override. */
export const withoutTools = (f: TaskFrontmatter): TaskFrontmatter => {
  const { tools: _tools, ...rest } = f;
  void _tools;
  return rest;
};

/** Ids in run order, as `project/task`. */
export const order = (results: Awaited<ReturnType<RunnerEngine["runUntilIdle"]>>) =>
  results.flatMap((r) =>
    r.kind === "ran" ? [`${r.projectId}/${r.outcome.task.frontmatter.id}`] : [],
  );

/** The committed repo every test starts from. Built once per file: five git spawns per test add up. */
let template: string;

async function buildTemplate(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-template-")));
  const g = (args: string[]) =>
    execCommand("git", args, { launch: { kind: "direct" }, cwd: dir, timeoutMs: 60_000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(dir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
  return dir;
}

export interface EngineRig {
  dataRoot: string;
  workDir: string;
  engine: RunnerEngine;
  project: Project;
  projectDir: string;
  store: TaskStore;
}

/**
 * Registers the hooks every engine test file needs: a data root, a git work dir registered as
 * project `default`, and an engine. `assign` hands the fixtures to the file's own variables
 * before each test; a test may replace its `engine`.
 */
export function useEngineRig(assign: (rig: EngineRig) => void): void {
  beforeAll(async () => {
    template = await buildTemplate();
  }, 120_000);
  afterAll(async () => {
    await rm(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "boof-runner-data-"));
    workDir = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-work-")));
    // A git repo, so worktree isolation engages.
    await cp(template, workDir, { recursive: true });

    await new SettingsStore(dataRoot).save({
      ...defaultSettings(),
      runner: { enabled: true, concurrency: 1 },
      defaultProject: "default",
    } as never);
    project = await new ProjectStore(dataRoot).create({ workingDirectory: workDir, id: "default" });
    projectDir = new ProjectStore(dataRoot).dir(project.id);
    store = new TaskStore(projectDir);

    engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
    resetMock();
    assign({ dataRoot, workDir, engine, project, projectDir, store });
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    for (const r of extraRepos.splice(0))
      await rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    resetMock();
    resetSandboxStatus();
  });
}
