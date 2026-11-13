import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  execCommand,
  LOCAL_PRINCIPAL,
  ProjectStore,
  SettingsStore,
  TaskStore,
} from "@boof/heart";
import {
  MockTool,
  resetMock,
  RunnerEngine,
  ToolRegistry,
  type RunOptions,
  type RunResult,
} from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

const dirs: string[] = [];
afterEach(async () => {
  resetMock();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10 });
});

// 9 goals: one root, two that wait for it, the rest further down the chain.
const NINE = [
  ["scaffold", []],
  ["models", ["scaffold"]],
  ["api", ["scaffold"]],
  ["list", ["models", "api"]],
  ["add", ["models", "api"]],
  ["edit", ["list"]],
  ["delete", ["list"]],
  ["filters", ["list"]],
  ["polish", ["add", "edit", "delete", "filters"]],
] as const;
const GOALS = {
  goals: NINE.map(([id, dependsOn]) => ({ id, title: `Goal ${id}`, details: "", dependsOn })),
};

/** A fake planner: it answers the draft request with the 9-goal JSON, everything else as the mock. */
class FakePlanner extends MockTool {
  override async run(opts: RunOptions): Promise<RunResult> {
    const base = await super.run(opts);
    if (!String(opts.systemPrompt ?? "").includes("drafting the task list")) return base;
    return { ...base, report: `Done.\n\n\`\`\`json\n${JSON.stringify(GOALS)}\n\`\`\`` };
  }
}

describe("draft -> activate -> sync(includeBlocked)", () => {
  it("creates all 9 tasks (1 pending, 8 blocked) and unskips dependents when a goal is done", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-actall-"));
    const work = await mkdtemp(join(tmpdir(), "boof-actall-work-"));
    dirs.push(root, work);
    const git = (args: string[]) =>
      execCommand("git", args, { launch: { kind: "direct" }, cwd: work, timeoutMs: 15000 });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@e.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(work, "README.md"), "# work\n");
    await git(["add", "."]);
    await git(["commit", "-m", "init"]);
    const mock = { tool: "mock", model: "mock-default" };
    await new SettingsStore(root).save({
      ...defaultSettings(),
      runner: { enabled: true, concurrency: 1 },
      defaultProject: "proj",
      roles: { planner: mock, developer: mock, reviewer: mock },
    });
    await new ProjectStore(root).create({ workingDirectory: work, id: "proj" });
    const registry = new ToolRegistry([new FakePlanner()]);
    const ctx: OpContext = {
      root,
      principal: LOCAL_PRINCIPAL,
      services: new TaskService(root, registry),
      authStore: new AuthStore(root),
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const call = (op: string, input: object) => getOp(op)!.execute(ctx, input) as Promise<any>;
    const engine = new RunnerEngine({ root, pollIntervalMs: 10, registry });
    const store = new TaskStore(new ProjectStore(root).dir("proj"));
    const tasks = () => store.list();

    await call("plans.create", { projectId: "proj", id: "pl", title: "Todo app" });
    await call("plans.draftGoals", { projectId: "proj", planId: "pl", ...mock });
    await engine.tick(); // runs the plan-draft task: the plan now holds the 9 goals
    const drafted = await call("plans.get", { projectId: "proj", planId: "pl" });
    expect(drafted.goals).toHaveLength(9);

    // Activate (as the wizard does: autoSync on) and sync with includeBlocked.
    await call("plans.update", {
      projectId: "proj",
      planId: "pl",
      status: "active",
      autoSync: true,
      expectedVersion: drafted.version,
    });
    const report = await call("plans.sync", {
      projectId: "proj",
      planId: "pl",
      includeBlocked: true,
    });
    expect(report.created).toHaveLength(9);
    expect(report.created.filter((c: any) => !c.skip)).toHaveLength(1);
    expect(report.created.filter((c: any) => c.skip)).toHaveLength(8);

    const planTasks = async () =>
      (await tasks()).filter((t: any) => t.frontmatter.planRef?.planId === "pl");
    let all = await planTasks();
    const forGoal = (g: string) => all.find((t: any) => t.frontmatter.planRef.goalId === g);
    expect(all).toHaveLength(9);
    expect(
      all.filter((t: any) => t.frontmatter.status === "pending" && !t.frontmatter.skip),
    ).toHaveLength(1);
    expect(all.filter((t: any) => t.frontmatter.labels.includes("blocked"))).toHaveLength(8);
    expect(forGoal("scaffold").frontmatter.skip).toBe(false);

    // Complete the first task; the engine's own sync then unskips its dependents (no manual sync).
    const first = await engine.tick();
    expect(first.kind).toBe("ran");
    await engine.syncAutoPlans();
    all = await planTasks();
    const ready = (g: string) => !forGoal(g).frontmatter.skip;
    expect(all).toHaveLength(9);
    expect(ready("models") && ready("api")).toBe(true);
    expect(forGoal("models").frontmatter.labels).not.toContain("blocked");
    expect(ready("list")).toBe(false);
    expect(forGoal("list").frontmatter.labels).toContain("blocked");
  });
});
