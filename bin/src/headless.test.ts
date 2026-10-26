import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentStatus,
  defaultSettings,
  parseGoal,
  ProjectStore,
  SettingsStore,
  TaskStore,
} from "@boof-runner/shared";
import { ToolRegistry, execCommand, mockState, resetMock } from "@boof-runner/runner";
import {
  drainQueue,
  ProjectResolutionError,
  runTask,
  scanRepoToTasks,
  toolOverride,
} from "./headless.js";
import { firstPositional, runCommand } from "./boof-runner.js";

let dataRoot: string;
let repo: string;
const extraRepos: string[] = [];
const projectsOf = () => new ProjectStore(dataRoot);
/** Task store of a project of the data root under test. */
const tasksOf = (projectId: string) => new TaskStore(projectsOf().dir(projectId));

/** Another git repository (removed after the test). */
async function extraRepo(label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `boof-cli-${label}-`)));
  extraRepos.push(dir);
  await initGitRepo(dir);
  return dir;
}
const registry = () => new ToolRegistry();
const silent = () => {};

function goalXml(goal: string, status: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>${goal}</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="${status}">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;
}

async function initGitRepo(dir: string): Promise<void> {
  const g = (args: string[]) => execCommand("git", args, { cwd: dir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(dir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-cli-data-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-cli-repo-")));
  await initGitRepo(repo);
  resetMock();
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
  for (const d of extraRepos.splice(0)) await rm(d, { recursive: true, force: true });
  resetMock();
});

describe("runTask (headless)", () => {
  it("enqueues a prompt and drives it to done with the mock tool", async () => {
    const res = await runTask({
      root: dataRoot,
      prompt: "Build a widget.",
      repo,
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("done");
    const task = await tasksOf(res.projectId).get(res.id);
    expect(task?.frontmatter.status).toBe("done");
    // The passed repo was registered as a project; only runner.enabled changed in settings.
    const projects = await projectsOf().list();
    expect(projects.map((p) => p.workingDirectory)).toEqual([repo]);
    expect(projects[0]!.origin).toEqual({ kind: "cli" });
    const settings = await new SettingsStore(dataRoot).load();
    expect(settings.runner.enabled).toBe(true);
    expect(settings).not.toHaveProperty("workingDirectory");
    expect(settings.defaultProject).toBeNull();
  });

  it("honours a mock marker in a single-line prompt longer than 80 chars", async () => {
    const store = new SettingsStore(dataRoot);
    const cur = await store.load();
    await store.save({
      ...cur,
      roles: { ...cur.roles, observer: { tool: "mock", model: "mock-default" } },
    });
    const prompt =
      "lo smop path [[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=CHANGES_REQUESTED,APPROVE]]";
    expect(prompt.length).toBeGreaterThan(80);
    const res = await runTask({
      root: dataRoot,
      prompt,
      repo,
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("done");
  });

  it("reports failure (ok=false) when a role errors", async () => {
    mockState.failRole = "developer";
    const res = await runTask({
      root: dataRoot,
      prompt: "Will fail.",
      repo,
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");
  });
});

describe("run --base and --title", () => {
  const git = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });

  it("firstPositional skips the values of --base and --title", () => {
    expect(firstPositional(["--base", "main", "--title", "A title", "the prompt"])).toBe(
      "the prompt",
    );
    expect(firstPositional(["the prompt", "--base", "x"])).toBe("the prompt");
  });

  it("sets frontmatter base and title and starts the worktree at base", async () => {
    const first = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repo, "later.txt"), "later\n");
    await git(["add", "."]);
    await git(["commit", "-m", "later"]);

    const log = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await runCommand([
        "--data",
        dataRoot,
        "--repo",
        repo,
        "--tool",
        "mock",
        "--base",
        first,
        "--title",
        "My title",
        "Build a widget.",
      ]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);

    const [project] = await projectsOf().list();
    const tasks = await tasksOf(project!.id).list();
    expect(tasks).toHaveLength(1);
    const fm = tasks[0]!.frontmatter;
    expect(fm.base).toBe(first);
    expect(fm.title).toBe("My title");
    expect((await git(["rev-parse", `boof-runner/${fm.id}`])).stdout.trim()).toBe(first);
  });

  it("an unknown --base fails the run", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      const code = await runCommand([
        "--data",
        dataRoot,
        "--repo",
        repo,
        "--tool",
        "mock",
        "--base",
        "no-such-ref",
        "Build a widget.",
      ]);
      expect(code).toBe(1);
    } finally {
      console.log = log;
    }
  });
});

describe("scanRepoToTasks (scan mode)", () => {
  it("dry-run lists actionable units without creating tasks", async () => {
    await mkdir(join(repo, "core"), { recursive: true });
    await writeFile(join(repo, "core", "goal.boof.xml"), goalXml("Core", "plan"), "utf8");
    let output = "";
    const summary = await scanRepoToTasks({
      root: dataRoot,
      repo,
      dryRun: true,
      out: (c) => (output += c),
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.created).toEqual([]);
    expect(summary.units.map((u) => u.id)).toEqual(["core"]);
    expect(output).toContain("dry run");
    // No task files created, and the repo was not registered by a dry run.
    expect(await projectsOf().list()).toEqual([]);
  });

  it("creates one task per not-done unit and drainQueue bumps each goal to done", async () => {
    await mkdir(join(repo, "core"), { recursive: true });
    await mkdir(join(repo, "web"), { recursive: true });
    await writeFile(join(repo, "core", "goal.boof.xml"), goalXml("Core", "plan"), "utf8");
    await writeFile(join(repo, "web", "goal.boof.xml"), goalXml("Web", "review"), "utf8");
    const done = goalXml("Done already", "done");
    await mkdir(join(repo, "shipped"), { recursive: true });
    await writeFile(join(repo, "shipped", "goal.boof.xml"), done, "utf8");

    const summary = await scanRepoToTasks({
      root: dataRoot,
      repo,
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    // Two not-done units → two tasks; the done unit is skipped.
    expect(summary.created).toHaveLength(2);
    expect(summary.projectId).toBeDefined();
    const created = await tasksOf(summary.projectId!).list();
    expect(created).toHaveLength(2);
    expect(created.every((t) => t.frontmatter.planRef && !t.frontmatter.boofGoal)).toBe(true);

    const drain = await drainQueue({ root: dataRoot, registry: registry(), out: silent });
    expect(drain.ran).toBe(2);
    expect(drain.failed).toBe(0);

    // Both scanned goal files were bumped to done.
    expect(
      currentStatus(parseGoal(await readFile(join(repo, "core", "goal.boof.xml"), "utf8"))),
    ).toBe("done");
    expect(
      currentStatus(parseGoal(await readFile(join(repo, "web", "goal.boof.xml"), "utf8"))),
    ).toBe("done");
  });
});

describe("toolOverride", () => {
  it("overrides the observer only when one is configured", () => {
    const withObserver = defaultSettings();
    withObserver.roles.observer = { tool: "claude-code", model: "sonnet" };
    const a = { tool: "mock", model: "mock-default" };
    expect(toolOverride(registry(), withObserver, "mock")).toEqual({
      planner: a,
      developer: a,
      reviewer: a,
      observer: a,
    });
    const without = toolOverride(registry(), defaultSettings(), "mock");
    expect(without).toEqual({ planner: a, developer: a, reviewer: a });
    expect(without).not.toHaveProperty("observer");
    expect(toolOverride(registry(), withObserver)).toBeUndefined();
  });
});

describe("multi-project run and scan", () => {
  it("--repo registers an unknown repository once and reuses the project on the next call", async () => {
    let output = "";
    const out = (c: string) => (output += c);
    const first = await runTask({
      root: dataRoot,
      prompt: "First.",
      repo,
      tool: "mock",
      registry: registry(),
      out,
    });
    const second = await runTask({
      root: dataRoot,
      prompt: "Second.",
      repo,
      tool: "mock",
      registry: registry(),
      out,
    });
    expect(first.ok && second.ok).toBe(true);
    expect(second.projectId).toBe(first.projectId);
    const projects = await projectsOf().list();
    expect(projects).toHaveLength(1);
    expect(output.match(/Registered project/g)).toHaveLength(1);
    expect(output).toContain(`Registered project '${first.projectId}' for ${repo}`);
    expect(await tasksOf(first.projectId).list()).toHaveLength(2);
  });

  it("--repo finds the project through a symlink and a trailing path variation", async () => {
    const { symlink } = await import("node:fs/promises");
    const link = join(dataRoot, "..", `link-${Date.now()}`);
    await symlink(repo, link);
    extraRepos.push(link);
    const a = await runTask({
      root: dataRoot,
      prompt: "A.",
      repo,
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    const b = await runTask({
      root: dataRoot,
      prompt: "B.",
      repo: link,
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    expect(b.projectId).toBe(a.projectId);
    expect(await projectsOf().list()).toHaveLength(1);
  });

  it("--project queues in that project; an unknown id, a paused or archived project is refused", async () => {
    const project = await projectsOf().create({ workingDirectory: repo, id: "app" });
    const res = await runTask({
      root: dataRoot,
      prompt: "Go.",
      project: "app",
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    expect(res).toMatchObject({ projectId: "app", ok: true });
    expect(await tasksOf("app").list()).toHaveLength(1);

    const attempt = (over: object) =>
      runTask({
        root: dataRoot,
        prompt: "x",
        tool: "mock",
        registry: registry(),
        out: silent,
        ...over,
      });
    await expect(attempt({ project: "nope" })).rejects.toThrow(/Project not found: nope/);
    await projectsOf().update(project.id, { paused: true });
    await expect(attempt({ project: "app" })).rejects.toThrow(/paused/);
    await projectsOf().update(project.id, { paused: false, archived: true });
    await expect(attempt({ project: "app" })).rejects.toThrow(/archived/);
    expect(await tasksOf("app").list()).toHaveLength(1); // nothing was queued by the refusals
  });

  it("without --project/--repo it uses defaultProject, or explains what is missing", async () => {
    await expect(
      runTask({ root: dataRoot, prompt: "x", tool: "mock", registry: registry(), out: silent }),
    ).rejects.toBeInstanceOf(ProjectResolutionError);
    await projectsOf().create({ workingDirectory: repo, id: "app" });
    await new SettingsStore(dataRoot).update({ defaultProject: "app" });
    const res = await runTask({
      root: dataRoot,
      prompt: "x",
      tool: "mock",
      registry: registry(),
      out: silent,
    });
    expect(res).toMatchObject({ projectId: "app", ok: true });
  });

  it("never writes a working directory to settings; runner.enabled is the only change and is logged", async () => {
    const store = new SettingsStore(dataRoot);
    const before = await store.load();
    expect(before.runner.enabled).toBe(false);
    let output = "";
    await runTask({
      root: dataRoot,
      prompt: "x",
      repo,
      tool: "mock",
      registry: registry(),
      out: (c) => (output += c),
    });
    const after = await store.load();
    expect(after).toEqual({ ...before, runner: { ...before.runner, enabled: true } });
    expect(output).toContain("runner.enabled = true");
    // Already enabled: no further change, no further log line.
    output = "";
    await runTask({
      root: dataRoot,
      prompt: "y",
      repo,
      tool: "mock",
      registry: registry(),
      out: (c) => (output += c),
    });
    expect(output).not.toContain("runner.enabled");
  });

  it("scan registers the repository if needed and reuses it; --project must match the repo", async () => {
    await mkdir(join(repo, "core"), { recursive: true });
    await writeFile(join(repo, "core", "goal.boof.xml"), goalXml("Core", "plan"), "utf8");
    const first = await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    expect(first.created).toHaveLength(1);
    const projects = await projectsOf().list();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.workingDirectory).toBe(repo);
    expect(first.projectId).toBe(projects[0]!.id);

    const second = await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    expect(second.projectId).toBe(first.projectId);
    expect(await projectsOf().list()).toHaveLength(1);
    // Re-scanning is idempotent: the plan already has its task.
    expect(second.created).toHaveLength(0);
    expect(await tasksOf(first.projectId!).list()).toHaveLength(1);

    const withProject = await scanRepoToTasks({
      root: dataRoot,
      repo,
      project: first.projectId,
      tool: "mock",
      out: silent,
    });
    expect(withProject.projectId).toBe(first.projectId);

    const other = await extraRepo("other");
    await mkdir(join(other, "x"), { recursive: true });
    await writeFile(join(other, "x", "goal.boof.xml"), goalXml("X", "plan"), "utf8");
    await expect(
      scanRepoToTasks({ root: dataRoot, repo: other, project: first.projectId, out: silent }),
    ).rejects.toThrow(/works on/);
    // Scan never touched global settings.
    expect((await new SettingsStore(dataRoot).load()).defaultProject).toBeNull();
  });

  it("e2e: two repos, scan into each, `run --all` drains both; `--project` drains one", async () => {
    const other = await extraRepo("second");
    for (const [dir, goal] of [
      [repo, "Alpha"],
      [other, "Beta"],
    ] as const) {
      await mkdir(join(dir, "unit"), { recursive: true });
      await writeFile(join(dir, "unit", "goal.boof.xml"), goalXml(goal, "plan"), "utf8");
      await scanRepoToTasks({ root: dataRoot, repo: dir, tool: "mock", out: silent });
    }
    const projects = await projectsOf().list();
    expect(projects).toHaveLength(2);

    // Drain only the first project.
    const only = await drainQueue({
      root: dataRoot,
      project: projects[0]!.id,
      registry: registry(),
      out: silent,
    });
    expect(only.ran).toBe(1);
    expect((await tasksOf(projects[1]!.id).list())[0]!.frontmatter.status).toBe("pending");

    // Then everything that is left, through the CLI entry point.
    const log = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await runCommand(["--all", "--data", dataRoot]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
    for (const p of projects) {
      const tasks = await tasksOf(p.id).list();
      expect(tasks.map((t) => t.frontmatter.status)).toEqual(["done"]);
    }
    for (const dir of [repo, other]) {
      expect(
        currentStatus(parseGoal(await readFile(join(dir, "unit", "goal.boof.xml"), "utf8"))),
      ).toBe("done");
    }
    await expect(drainQueue({ root: dataRoot, project: "ghost", out: silent })).rejects.toThrow(
      /Project not found/,
    );
  });

  it("migrates a v1 data root on first use and runs its pending task under project `default`", async () => {
    await mkdir(join(dataRoot, "tasks", "pending"), { recursive: true });
    await mkdir(join(dataRoot, "commands"), { recursive: true });
    const v1 = defaultSettings() as unknown as Record<string, unknown>;
    delete v1.schemaVersion;
    delete v1.defaultProject;
    await writeFile(
      join(dataRoot, "settings.json"),
      JSON.stringify({
        ...v1,
        runner: { enabled: true },
        workingDirectory: repo,
        roles: {
          planner: { tool: "mock", model: "mock-default" },
          developer: { tool: "mock", model: "mock-default" },
          reviewer: { tool: "mock", model: "mock-default" },
        },
      }),
    );
    await writeFile(
      join(dataRoot, "tasks", "pending", "old.md"),
      `---\nid: old\ntitle: Old\nstatus: pending\npriority: 5\nskip: false\nlabels: []\ncommand: null\nattachments: []\nquestions: none\nruns: 1\ncompletedRuns: 0\ncreated: "2026-06-04T10:00:00.000Z"\nupdated: "2026-06-04T10:00:00.000Z"\n---\n\n## Prompt\nDo the old thing.\n`,
    );
    const drain = await drainQueue({ root: dataRoot, registry: registry(), out: silent });
    expect(drain.ran).toBe(1);
    expect((await projectsOf().get("default"))?.workingDirectory).toBe(repo);
    expect((await tasksOf("default").get("old"))?.frontmatter.status).toBe("done");
    expect((await new SettingsStore(dataRoot).load()).defaultProject).toBe("default");
  });
});
