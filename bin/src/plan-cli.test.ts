import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentStatus,
  parseGoal,
  PlanStore,
  ProjectStore,
  serializeGoal,
  serializePlan,
  TaskStore,
  type BoofGoal,
} from "@boof-runner/shared";
import {
  buildUnitPrompt,
  execCommand,
  selectActionableUnits,
  ToolRegistry,
} from "@boof-runner/runner";
import { drainQueue, scanRepoToTasks } from "./headless.js";
import { planCommand } from "./plan-cli.js";

let dataRoot: string;
let repo: string;
const silent = () => {};

const unit = (text: string, status: "plan" | "done" = "plan"): BoofGoal => ({
  overal: {
    goal: text,
    stack: "TypeScript",
    rules: { do: ["Write a failing test first."], dont: [] },
  },
  progress: {
    versions: [{ number: 1, status, description: "seed" }],
    tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
  },
});

async function writeUnit(dir: string, g: BoofGoal): Promise<void> {
  await mkdir(join(repo, dir), { recursive: true });
  await writeFile(join(repo, dir, "goal.boof.xml"), serializeGoal(g), "utf8");
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-plancli-data-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-plancli-repo-")));
  const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeUnit("core", unit("Core"));
  await writeUnit("api", unit("Api"));
  await writeUnit("packages/web", unit("Web"));
  await writeUnit("shipped", unit("Shipped", "done"));
  await writeFile(
    join(repo, "plan.boof.xml"),
    serializePlan({
      goals: [
        { id: "shipped", path: "shipped", order: 1, status: "done", dependsOn: [] },
        { id: "core", path: "core", order: 2, status: "plan", dependsOn: [] },
        { id: "api", path: "api", order: 3, status: "plan", dependsOn: ["core"] },
        { id: "web", path: "packages/web", order: 4, status: "plan", dependsOn: ["api"] },
      ],
    }),
    "utf8",
  );
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("scan on top of plans (golden)", () => {
  it("creates the same tasks as before: titles, labels, prompts, priorities; planRef instead of boofGoal", async () => {
    const before = await selectActionableUnits(repo);
    const summary = await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    expect(summary.created).toHaveLength(before.length);
    const store = new TaskStore(new ProjectStore(dataRoot).dir(summary.projectId!));
    const tasks = await store.list();
    expect(tasks).toHaveLength(3);

    for (const [i, u] of before.entries()) {
      const t = tasks.find((x) => x.frontmatter.title === `boof: ${u.id}`)!;
      expect(t, u.id).toBeDefined();
      expect(t.frontmatter.id).toBe(`boof-${u.id}`);
      expect(t.frontmatter.labels.slice(0, 2)).toEqual(["boof-scan", `boof-status:${u.status}`]);
      expect(t.frontmatter.priority).toBe((before.length - i) * 10);
      expect(t.frontmatter.boofGoal).toBeUndefined();
      expect(t.frontmatter.planRef).toMatchObject({ planId: "repo", goalId: u.id, revision: 1 });
      // The prompt is the old prompt plus a trailing "## Plan" section.
      const cut = t.body.prompt.indexOf("\n\n## Plan\n");
      expect(t.body.prompt.slice(0, cut)).toBe(buildUnitPrompt(u, repo));
      expect(t.frontmatter.skip).toBe(u.blocked);
    }
  });

  it("a re-scan creates nothing new; a spec change shows up as a rewritten pending task", async () => {
    const first = await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    const again = await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    expect(again.created).toEqual([]);
    await writeUnit("core", unit("Core, changed"));
    await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    const store = new TaskStore(new ProjectStore(dataRoot).dir(first.projectId!));
    expect((await store.get("boof-core"))!.body.prompt).toContain("Core, changed");
    expect(await store.list()).toHaveLength(3);
  });

  it("drains in dependency order, records plan history and bumps the repo XML", async () => {
    const summary = await scanRepoToTasks({ root: dataRoot, repo, tool: "mock", out: silent });
    const registry = new ToolRegistry();
    const drained = await drainQueue({ root: dataRoot, registry, out: silent });
    expect(drained).toEqual({ ran: 3, failed: 0 });
    const plan = await new PlanStore(new ProjectStore(dataRoot).dir(summary.projectId!)).require(
      "repo",
    );
    expect(plan.goals.map((g) => [g.id, g.status])).toEqual([
      ["shipped", "done"],
      ["core", "done"],
      ["api", "done"],
      ["web", "done"],
    ]);
    for (const dir of ["core", "api", "packages/web"]) {
      expect(
        currentStatus(parseGoal(await readFile(join(repo, dir, "goal.boof.xml"), "utf8"))),
      ).toBe("done");
    }
  });
});

describe("plan subcommands", () => {
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await planCommand(
      [...args, "-d", dataRoot],
      () => dataRoot,
      (l) => lines.push(l),
      (l) => errs.push(l),
    );
    return { code, lines, errs };
  };

  it("import creates an active plan that is already approved", async () => {
    const projects = new ProjectStore(dataRoot);
    await projects.create({ workingDirectory: repo, id: "demo" });
    expect((await run(["import", "--project", "demo"])).code).toBe(0);
    const plan = await new PlanStore(projects.dir("demo")).require("repo");
    expect(plan.status).toBe("active");
    expect(plan.approvedBy).toMatchObject({ principalId: "local" });
  });

  it("import, sync --dry-run, sync, export", async () => {
    const projects = new ProjectStore(dataRoot);
    const project = await projects.create({ workingDirectory: repo, id: "demo" });

    const imp = await run(["import", "--project", project.id]);
    expect(imp.code).toBe(0);
    expect(imp.lines.join("\n")).toContain("4 added");
    const again = await run(["import", "--project", project.id]);
    expect(again.lines.join("\n")).toContain("0 added");

    const dry = await run(["sync", "--project", "demo", "--plan", "repo", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.lines.join("\n")).toContain("(dry run) would create boof-core");
    expect(await new TaskStore(projects.dir("demo")).list()).toHaveLength(0);

    const real = await run(["sync", "--project", "demo", "--plan", "repo"]);
    expect(real.lines.at(-1)).toBe("1 created, 0 updated, 0 archived, 2 blocked");
    expect(await new TaskStore(projects.dir("demo")).list()).toHaveLength(1);

    const out = join(dataRoot, "exported");
    const exp = await run(["export", "--project", "demo", "--plan", "repo", "--out", out]);
    expect(exp.code).toBe(0);
    expect((await readdir(out)).sort()).toEqual([
      "api",
      "core",
      "packages",
      "plan.boof.xml",
      "shipped",
    ]);
    expect(await readFile(join(out, "core", "goal.boof.xml"), "utf8")).toBe(
      await readFile(join(repo, "core", "goal.boof.xml"), "utf8"),
    );
  });

  it("usage errors return 1: missing flags, unknown project/plan, draft plan sync", async () => {
    const projects = new ProjectStore(dataRoot);
    await projects.create({ workingDirectory: repo, id: "demo" });
    expect((await run(["sync", "--project", "demo"])).code).toBe(1);
    expect((await run(["export", "--project", "demo", "--plan", "x"])).code).toBe(1);
    expect((await run(["sync", "--project", "ghost", "--plan", "x"])).code).toBe(1);
    expect((await run(["sync", "--project", "demo", "--plan", "nope"])).code).toBe(1);
    expect((await run(["bogus", "--project", "demo"])).code).toBe(1);
    await new PlanStore(projects.dir("demo")).create({
      id: "d",
      title: "D",
      source: { kind: "api" },
      goals: [],
    });
    const draft = await run(["sync", "--project", "demo", "--plan", "d"]);
    expect(draft.code).toBe(1);
    expect(draft.errs.join("\n")).toContain("not active");
  });
});
