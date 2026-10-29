import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyGoalInputs,
  AuthStore,
  defaultSettings,
  PlanStore,
  ProjectStore,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  TaskStore,
  testGoal,
  type Goal,
  type Plan,
  type Project,
} from "@boof-runner/shared";
import { execCommand } from "./exec.js";
import { buildGoalPrompt, PlanNotActiveError, syncPlan, taskStatusForPlan } from "./plan-sync.js";

let dataRoot: string;
let repo: string;
let project: Project;
let projectDir: string;
let plans: PlanStore;
let tasks: TaskStore;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-sync-data-"));
  repo = await mkdtemp(join(tmpdir(), "boof-sync-repo-"));
  const projects = new ProjectStore(dataRoot);
  project = await projects.create({ workingDirectory: repo, id: "proj" });
  projectDir = projects.dir("proj");
  plans = new PlanStore(projectDir);
  tasks = new TaskStore(projectDir);
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function makePlan(goals: Goal[], over: Partial<Plan> = {}): Promise<Plan> {
  return plans.create({
    id: "p",
    title: "P",
    status: "active",
    source: { kind: "api" },
    goals,
    ...over,
  });
}

const sync = (extra: Partial<Parameters<typeof syncPlan>[0]> = {}) =>
  syncPlan({ projectDir, project, planId: "p", ...extra });

/** Change a goal's spec the way PlanService does (revision bump) and save. */
async function editGoal(id: string, goalText: string): Promise<Plan> {
  return plans.modify("p", (p) => {
    const g = p.goals.find((x) => x.id === id)!;
    return {
      ...p,
      goals: applyGoalInputs(p.goals, [{ ...g, spec: { ...g.spec, goal: goalText } }], {
        replace: false,
      }),
    };
  });
}

/** What the engine does when a plan task finishes. */
async function finishTask(taskId: string): Promise<void> {
  if ((await tasks.get(taskId))!.frontmatter.status === "pending") {
    await tasks.transition(taskId, "running");
  }
  await tasks.transition(taskId, "done");
  const task = (await tasks.get(taskId))!;
  const ref = task.frontmatter.planRef!;
  await plans.modify("p", (p) => ({
    ...p,
    goals: p.goals.map((g) =>
      g.id === ref.goalId
        ? {
            ...g,
            status: "done" as const,
            taskId: null,
            history: [
              ...g.history,
              {
                revision: ref.revision,
                status: "done" as const,
                description: "x",
                at: new Date().toISOString(),
              },
            ],
          }
        : g,
    ),
  }));
}

const byGoal = async (goalId: string) =>
  (await tasks.list()).filter((t) => t.frontmatter.planRef?.goalId === goalId);

describe("syncPlan: materialising goals", () => {
  it("two overlapping syncs of one plan create each goal's task once", async () => {
    await makePlan([testGoal("a", 1)]);
    const [x, y] = await Promise.all([sync(), sync()]);
    expect(x.created.length + y.created.length).toBe(1);
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect((await plans.require("p")).goals[0]!.taskId).toBe(all[0]!.frontmatter.id);
  });

  it("creates a task for each unblocked goal only, with the goal prompt and refs", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2, ["a"])]);
    const res = await sync();
    expect(res.created.map((c) => c.goalId)).toEqual(["a"]);
    expect(res.skipped).toEqual([{ goalId: "b", reason: "blocked" }]);
    const [t] = await tasks.list();
    expect(t!.frontmatter).toMatchObject({
      id: "boof-a",
      title: "boof: A",
      status: "pending",
      skip: false,
      priority: 20,
      planRef: { planId: "p", goalId: "a", revision: 1 },
      promptSource: "plan",
    });
    expect(t!.frontmatter.labels).toEqual(["plan:p", "goal:a"]);
    expect(t!.body.prompt).toBe(buildGoalPrompt(res.plan.goals[0]!, "p", repo));
    expect(res.plan.goals[0]!.taskId).toBe("boof-a");
    expect(res.plan.goals[0]!.synced?.revision).toBe(1);
  });

  it("is idempotent: a second sync changes nothing, not even the plan version", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2, ["a"])]);
    const first = await sync();
    const second = await sync();
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.archived).toEqual([]);
    expect(second.plan.version).toBe(first.plan.version);
    expect(await tasks.list()).toHaveLength(1);
  });

  it("creates the next goal once its dependency is done", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2, ["a"])]);
    await sync();
    await finishTask("boof-a");
    const res = await sync();
    expect(res.created.map((c) => c.goalId)).toEqual(["b"]);
    expect(res.plan.goals.find((g) => g.id === "a")!.taskId).toBeNull();
    expect((await byGoal("a"))[0]!.frontmatter.status).toBe("done");
    expect(await byGoal("b")).toHaveLength(1);
    // The done goal is not materialised again.
    expect((await sync()).created).toEqual([]);
  });

  it("with includeBlocked, blocked goals get a skipped task that unskips when unblocked", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2, ["a"])]);
    const res = await sync({ includeBlocked: true });
    expect(res.created.map((c) => [c.goalId, c.skip])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    const b = (await byGoal("b"))[0]!;
    expect(b.frontmatter.skip).toBe(true);
    expect(b.frontmatter.labels).toContain("blocked");
    expect(b.frontmatter.priority).toBe(10);

    await finishTask("boof-a");
    const again = await sync();
    expect(again.updated).toEqual([
      { goalId: "b", taskId: "boof-b", action: "unskipped", revision: 1 },
    ]);
    const unblocked = (await byGoal("b"))[0]!;
    expect(unblocked.frontmatter.skip).toBe(false);
    expect(unblocked.frontmatter.labels).not.toContain("blocked");
  });

  it("skips a pending task when its goal becomes blocked, and unskips later", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2)]);
    await sync();
    // b now depends on a: the pending task of b must wait.
    await plans.modify("p", (p) => ({
      ...p,
      goals: applyGoalInputs(p.goals, [{ ...p.goals[1]!, dependsOn: ["a"] }], { replace: false }),
    }));
    const res = await sync();
    expect(res.skipped.map((s) => s.goalId)).toContain("b");
    const b = (await byGoal("b"))[0]!;
    expect(b.frontmatter.skip).toBe(true);
    expect(b.frontmatter.labels).toContain("blocked");
    // dependsOn is part of the content, so the revision moved and the prompt was rewritten too.
    expect(b.frontmatter.planRef!.revision).toBe(2);
  });

  it("creates tasks as draft when asked (plans of review-trust clients)", async () => {
    await makePlan([testGoal("a", 1)], { source: { kind: "api", client: "bot" } });
    const res = await sync({ createStatus: "draft" });
    expect(res.created[0]!.status).toBe("draft");
    const t = (await tasks.list())[0]!;
    expect(t.frontmatter.status).toBe("draft");
    expect(t.frontmatter.labels).toContain("external:bot");
    expect(t.frontmatter.origin).toEqual({ kind: "api", client: "bot" });
  });

  it("refuses a plan that is not active", async () => {
    await makePlan([testGoal("a", 1)], { status: "draft" });
    await expect(sync()).rejects.toBeInstanceOf(PlanNotActiveError);
  });

  it("dry run reports but writes nothing", async () => {
    const created = await makePlan([testGoal("a", 1)]);
    const res = await sync({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.created).toHaveLength(1);
    expect(await tasks.list()).toEqual([]);
    expect((await plans.require("p")).version).toBe(created.version);
  });
});

describe("syncPlan: goal changes (section 5)", () => {
  it("rewrites the prompt of a pending task and logs the change", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    await editGoal("a", "Build a better a");
    const res = await sync();
    expect(res.updated).toEqual([
      { goalId: "a", taskId: "boof-a", action: "rewritten", revision: 2 },
    ]);
    const t = (await tasks.get("boof-a"))!;
    expect(t.body.prompt).toContain("Build a better a");
    expect(t.body.prompt).toContain("- Revision: 2");
    expect(t.frontmatter.planRef!.revision).toBe(2);
    expect(t.body.log).toContain("## Plan change");
    expect(t.body.log).toContain('goal: "Build a" → "Build a better a"');
    expect(await tasks.list()).toHaveLength(1);
    expect((await sync()).updated).toEqual([]);
  });

  it("keeps an edit made between the sync's read and its write", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    await editGoal("a", "Build a better a");
    const original = TaskStore.prototype.list;
    const spy = vi.spyOn(TaskStore.prototype, "list").mockImplementation(async function (
      this: TaskStore,
    ) {
      const snapshot = await original.call(this);
      // a user edit lands after the sync read its copy of the tasks
      const t = (await tasks.get("boof-a"))!;
      t.frontmatter.title = "Renamed by the user";
      t.frontmatter.priority = 99;
      t.frontmatter.labels = ["mine"];
      await tasks.save(t);
      return snapshot;
    });
    try {
      const res = await sync();
      expect(res.updated[0]!.action).toBe("rewritten");
    } finally {
      spy.mockRestore();
    }
    const after = (await tasks.get("boof-a"))!;
    expect(after.frontmatter.title).toBe("Renamed by the user");
    expect(after.frontmatter.priority).toBe(99);
    expect(after.frontmatter.labels).toEqual(["mine"]);
    expect(after.body.prompt).toContain("Build a better a");
    expect(after.frontmatter.planRef!.revision).toBe(2);
    expect(after.body.log).toContain("## Plan change");
  });

  it("appends the diff instead of overwriting a hand-edited prompt, and labels needs-review", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    const t = (await tasks.get("boof-a"))!;
    t.body.prompt = "My own prompt.";
    t.frontmatter.promptSource = "manual";
    await tasks.save(t);
    await editGoal("a", "Changed goal");
    const res = await sync();
    expect(res.updated[0]!.action).toBe("appended");
    const after = (await tasks.get("boof-a"))!;
    expect(after.body.prompt.startsWith("My own prompt.")).toBe(true);
    expect(after.body.prompt).toContain("Changed goal");
    expect(after.frontmatter.labels).toContain("needs-review");
    expect(after.frontmatter.promptSource).toBe("manual");
  });

  it("rewrites a parked (action) task and keeps its questions; a failed task stays failed", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2)]);
    await sync({ includeBlocked: true });
    await tasks.transition("boof-a", "running");
    await tasks.transition("boof-a", "action", (t) => {
      t.frontmatter.questions = "pending";
      t.body.questions = "1. Which db?";
    });
    await tasks.transition("boof-b", "running");
    await tasks.transition("boof-b", "failed");
    await editGoal("a", "New A");
    await editGoal("b", "New B");
    await sync();
    const a = (await tasks.get("boof-a"))!;
    expect(a.frontmatter.status).toBe("action");
    expect(a.body.questions).toBe("1. Which db?");
    expect(a.body.prompt).toContain("New A");
    const b = (await tasks.get("boof-b"))!;
    expect(b.frontmatter.status).toBe("failed");
    expect(b.body.prompt).toContain("New B");
  });

  it("injects a prompt into a running task once, and labels it stale-revision", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    await tasks.transition("boof-a", "running");
    await editGoal("a", "Running goal v2");
    const res = await sync();
    expect(res.updated).toEqual([
      { goalId: "a", taskId: "boof-a", action: "injected", revision: 2 },
    ]);
    const injected = await readFile(taskPromptInjectionsPath(projectDir, "boof-a"), "utf8");
    expect(injected).toContain("spec changed to revision 2:");
    expect(injected).toContain("Running goal v2");
    expect(injected).toContain("Adjust the remaining work accordingly.");
    const t = (await tasks.get("boof-a"))!;
    expect(t.frontmatter.labels).toContain("stale-revision");
    expect(t.frontmatter.planRef!.revision).toBe(1);
    // Not injected twice, and no second task while the first one runs.
    expect((await sync()).updated).toEqual([]);
    expect(await tasks.list()).toHaveLength(1);
  });

  it("creates a follow-up for a done goal whose spec changed, and reopens the goal", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    await finishTask("boof-a");
    expect((await sync()).created).toEqual([]);

    await editGoal("a", "Spec v2");
    const res = await sync();
    expect(res.created).toHaveLength(1);
    expect(res.created[0]).toMatchObject({ goalId: "a", followUp: true, revision: 2 });
    const goal = res.plan.goals[0]!;
    expect(goal.status).toBe("develop");
    expect(goal.history.at(-1)).toMatchObject({ status: "develop", revision: 2 });
    expect(goal.history.at(-1)!.description).toContain("spec changed");

    const follow = (await tasks.get(res.created[0]!.taskId))!;
    expect(follow.frontmatter.title).toBe("Update A to revision 2");
    expect(follow.frontmatter.planRef).toEqual({ planId: "p", goalId: "a", revision: 2 });
    expect(follow.body.prompt).toContain("### Previous spec (revision 1)");
    expect(follow.body.prompt).toContain("### New spec (revision 2)");
    expect(follow.body.prompt).toContain("goal: Build a");
    expect(follow.body.prompt).toContain("goal: Spec v2");
    expect(follow.body.prompt).toContain("-goal: Build a");
    expect(follow.body.prompt).toContain("+goal: Spec v2");
    // The original done task is untouched, and a re-sync is idempotent.
    expect((await tasks.get("boof-a"))!.frontmatter.status).toBe("done");
    expect((await sync()).created).toEqual([]);
  });

  it("running task finishing at an older revision gets a follow-up on the next sync", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    await tasks.transition("boof-a", "running");
    await editGoal("a", "Late change");
    await sync(); // injects
    await finishTask("boof-a"); // done at revision 1
    const res = await sync();
    expect(res.created).toHaveLength(1);
    expect(res.created[0]).toMatchObject({ followUp: true, revision: 2 });
    const follow = (await tasks.get(res.created[0]!.taskId))!;
    expect(follow.body.prompt).toContain("-goal: Build a");
    expect(follow.body.prompt).toContain("+goal: Late change");
  });

  it("archives pending tasks of a removed goal; running ones only stop with stopRunning", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2), testGoal("c", 3)]);
    await sync();
    await tasks.transition("boof-b", "running");
    await plans.modify("p", (p) => ({ ...p, goals: p.goals.filter((g) => g.id === "a") }));

    const first = await sync();
    expect(first.archived.map((x) => [x.goalId, x.action])).toEqual([["c", "archived"]]);
    const c = (await tasks.get("boof-c"))!;
    expect(c.frontmatter.status).toBe("archived");
    expect(c.frontmatter.labels).toContain("goal-removed");
    expect(existsSync(taskStopRequestPath(projectDir, "boof-b"))).toBe(false);
    expect((await tasks.get("boof-b"))!.frontmatter.status).toBe("running");

    const second = await sync({ stopRunning: true });
    expect(second.archived.map((x) => [x.goalId, x.action])).toEqual([["b", "stop-requested"]]);
    expect(existsSync(taskStopRequestPath(projectDir, "boof-b"))).toBe(true);
    // The kept goal's task is untouched.
    expect((await tasks.get("boof-a"))!.frontmatter.status).toBe("pending");
  });

  it("leaves the done task of a removed goal alone", async () => {
    await makePlan([testGoal("a", 1), testGoal("b", 2)]);
    await sync();
    await finishTask("boof-a");
    await plans.modify("p", (p) => ({ ...p, goals: p.goals.filter((g) => g.id === "b") }));
    const res = await sync();
    expect(res.archived).toEqual([]);
    expect((await tasks.get("boof-a"))!.frontmatter.status).toBe("done");
  });

  it("does not recreate a task the user archived for the same revision", async () => {
    await makePlan([testGoal("a", 1)]);
    await sync();
    await tasks.transition("boof-a", "archived");
    expect((await sync()).created).toEqual([]);
    // A new revision does get a task.
    await editGoal("a", "again");
    expect((await sync()).created).toHaveLength(1);
  });
});

describe("buildGoalPrompt: goals without an automated test", () => {
  it("does not ask for a failing test when tests.run is none", () => {
    const g = testGoal("docs", 1);
    g.spec.tests = { strategy: "manual review", technology: "none", run: "none" };
    const prompt = buildGoalPrompt(g, "p", "/repo");
    expect(prompt).toContain("There is no automated test command");
    expect(prompt).not.toContain("until `none` is green");
  });
});

describe("syncPlan: follow-up base and goal.tasks", () => {
  const git = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  async function initRepo(): Promise<void> {
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@e.com"]);
    await git(["config", "user.name", "T"]);
    await git(["commit", "--allow-empty", "-m", "init"]);
  }

  it("starts a follow-up from the previous task branch when it exists", async () => {
    await initRepo();
    await makePlan([testGoal("a", 1)]);
    await sync();
    await git(["branch", "boof-runner/boof-a"]);
    await finishTask("boof-a");
    await editGoal("a", "Spec v2");
    const res = await sync();
    const follow = (await tasks.get(res.created[0]!.taskId))!;
    expect(follow.frontmatter.base).toBe("boof-runner/boof-a");
  });

  it("falls back to the project default base when the previous branch is gone", async () => {
    await initRepo();
    project = await new ProjectStore(dataRoot).update("proj", { defaultBase: "main" });
    await makePlan([testGoal("a", 1)]);
    await sync();
    expect((await tasks.get("boof-a"))!.frontmatter.base).toBe("main");
    await finishTask("boof-a"); // no branch was ever created
    await editGoal("a", "Spec v2");
    const res = await sync();
    expect((await tasks.get(res.created[0]!.taskId))!.frontmatter.base).toBe("main");
  });

  it("lists every task of a goal with its branch and keeps the statuses current", async () => {
    await makePlan([testGoal("a", 1)]);
    const first = await sync();
    expect(first.plan.goals[0]!.tasks).toEqual([
      { taskId: "boof-a", revision: 1, status: "pending", branch: "boof-runner/boof-a" },
    ]);
    await finishTask("boof-a");
    await editGoal("a", "Spec v2");
    const res = await sync();
    const followId = res.created[0]!.taskId;
    expect(res.plan.goals[0]!.tasks).toEqual([
      { taskId: "boof-a", revision: 1, status: "done", branch: "boof-runner/boof-a" },
      { taskId: followId, revision: 2, status: "pending", branch: `boof-runner/${followId}` },
    ]);
    expect(res.plan.goals[0]!.taskId).toBe(followId);
  });
});

describe("syncPlan: dependency base and follow-ups", () => {
  const git = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  async function branchWithCommit(name: string): Promise<void> {
    await git(["checkout", "-q", "-b", name, "main"]);
    await git(["commit", "--allow-empty", "-m", name]);
    await git(["checkout", "-q", "main"]);
  }

  it("a follow-up keeps its own previous branch and lists dependency branches it does not contain", async () => {
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@e.com"]);
    await git(["config", "user.name", "T"]);
    await git(["commit", "--allow-empty", "-m", "init"]);
    await makePlan([testGoal("a", 1), testGoal("b", 2, ["a"])]);
    await sync();
    await branchWithCommit("boof-runner/boof-a");
    await finishTask("boof-a");
    const second = await sync();
    expect(second.created.map((c) => c.goalId)).toEqual(["b"]);
    expect((await tasks.get("boof-b"))!.frontmatter.base).toBe("boof-runner/boof-a");
    // b's own branch was made before a existed: it does not contain a's commit.
    await branchWithCommit("boof-runner/boof-b");
    await finishTask("boof-b");
    await editGoal("b", "Spec v2");
    const res = await sync();
    const follow = (await tasks.get(res.created[0]!.taskId))!;
    expect(follow.frontmatter.base).toBe("boof-runner/boof-b");
    expect(follow.body.prompt).toContain("## Dependencies");
    expect(follow.body.prompt).toContain("- boof-runner/boof-a");
    expect(follow.body.log).toContain("previous task");
    expect(follow.body.log).toContain("boof-runner/boof-a");
  });

  it("no dependency branch: falls back to the project default base and says so", async () => {
    await git(["init", "-b", "main"]);
    project = await new ProjectStore(dataRoot).update("proj", { defaultBase: "main" });
    await makePlan([testGoal("a", 1), testGoal("b", 2, ["a"])]);
    await sync();
    await finishTask("boof-a"); // no branch exists
    await sync();
    const b = (await tasks.get("boof-b"))!;
    expect(b.frontmatter.base).toBe("main");
    expect(b.body.log).toContain("project default base");
  });
});

describe("taskStatusForPlan: approval", () => {
  it("an approved active plan of a review client creates pending tasks; without approval, draft", async () => {
    const { client } = await new AuthStore(dataRoot).create({
      name: "r",
      scopes: ["plans:write"],
      trust: "review",
      projects: "*",
    });
    const plan = await makePlan([testGoal("a", 1)], { source: { kind: "api", client: client.id } });
    const settings = defaultSettings();
    expect(await taskStatusForPlan(dataRoot, plan, settings)).toBe("draft");
    const approved = {
      ...plan,
      approvedBy: { principalId: "local", at: new Date().toISOString(), version: 2 },
    };
    expect(await taskStatusForPlan(dataRoot, approved, settings)).toBe("pending");
    expect(await taskStatusForPlan(dataRoot, { ...approved, status: "draft" }, settings)).toBe(
      "draft",
    );
  });
});
