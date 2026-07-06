import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentStatus, parseGoal, SettingsStore, TaskStore } from "@boof-runner/shared";
import { ToolRegistry, execCommand, mockState, resetMock } from "@boof-runner/runner";
import { drainQueue, runTask, scanRepoToTasks } from "./headless.js";

let dataRoot: string;
let repo: string;
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
  repo = await mkdtemp(join(tmpdir(), "boof-cli-repo-"));
  resetMock();
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
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
    const task = await new TaskStore(dataRoot).get(res.id);
    expect(task?.frontmatter.status).toBe("done");
    // Runner was enabled and workingDirectory pointed at the passed repo.
    const settings = await new SettingsStore(dataRoot).load();
    expect(settings.runner.enabled).toBe(true);
    expect(settings.workingDirectory).toBe(repo);
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
    // No task files created.
    expect(await new TaskStore(dataRoot).list()).toEqual([]);
  });

  it("creates one task per not-done unit and drainQueue bumps each goal to done", async () => {
    await initGitRepo(repo);
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
    const created = await new TaskStore(dataRoot).list();
    expect(created).toHaveLength(2);
    expect(created.every((t) => t.frontmatter.boofGoal)).toBe(true);

    const drain = await drainQueue({ root: dataRoot, registry: registry(), out: silent });
    expect(drain.ran).toBe(2);
    expect(drain.failed).toBe(0);

    // Both scanned goal files were bumped to done.
    expect(currentStatus(parseGoal(await readFile(join(repo, "core", "goal.boof.xml"), "utf8")))).toBe(
      "done",
    );
    expect(currentStatus(parseGoal(await readFile(join(repo, "web", "goal.boof.xml"), "utf8")))).toBe(
      "done",
    );
  });
});
