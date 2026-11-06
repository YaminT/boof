import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  execCommand,
  HierarchyError,
  LOCAL_PRINCIPAL,
  SettingsStore,
  defaultSettings,
  taskStopRequestPath,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { OpError } from "../api/errors.js";
import { getOp } from "../api/registry.js";
import { TaskService, type ProjectService } from "../api/services/service.js";
import { cleanText, previewChange } from "./preview.js";

let base: string;
let service: TaskService;
let project: ProjectService;

const spec = (goal: string) => ({
  goal,
  stack: "TypeScript",
  rules: { do: ["Write a failing test first."], dont: [] },
  tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
});
const goal = (id: string, title: string, text = `Build ${id}`, deps: string[] = []) => ({
  id,
  title,
  dependsOn: deps,
  spec: spec(text),
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-concierge-preview-")));
  const root = join(base, "data");
  await mkdir(root, { recursive: true });
  let repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: repo });
  repo = await realpath(repo);
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await new SettingsStore(root).save(defaultSettings());
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  project = await service.requireProject("demo");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const op = (name: string) => getOp(name)!;

describe("cleanText", () => {
  it("strips control characters, collapses whitespace and caps with an ellipsis", () => {
    expect(cleanText("a\u0007b \n  c")).toBe("ab c");
    expect(cleanText("  spaced   out  ")).toBe("spaced out");
    expect(cleanText("x".repeat(300))).toBe(`${"x".repeat(119)}…`);
    expect(cleanText("hello", 5)).toBe("hello");
    expect(cleanText("hello", 4)).toBe("hel…");
    expect(cleanText("A\u0085B\u202EC\u200BD\u2066E\u009bF\u200C\u2060\uFEFF\u202A\u2069")).toBe(
      "ABCDEF",
    );
    expect(cleanText("ab\u00adcd\u2028ef")).toBe("abcdef");
  });
});

describe("previewChange", () => {
  it("uses the exact titles for confirm operations", async () => {
    const task = await project.create({ title: "Fix readme", prompt: "p" });
    const id = task.frontmatter.id;
    const child = await project.create({ title: "Child note", prompt: "p", parentId: id });
    const epic = await project.createEpic({ title: "Billing", id: "billing" });
    await project.create({ title: "Invoice", prompt: "p", epicId: epic.id });

    const deleted = await previewChange(
      op("tasks.delete"),
      { projectId: "demo", taskId: id },
      project,
    );
    expect(deleted.title).toBe(`Delete task "Fix readme" (${id})`);
    expect(deleted.details).toEqual([
      "has 1 subtasks; deleting is refused unless detach is set",
      "status: draft",
    ]);
    expect(deleted.destructive).toBe(true);
    expect(deleted.blocked).toContain("has 1 subtask,");
    expect(deleted.guard).toEqual({ kind: "task", id, stamp: task.frontmatter.updated });

    const detached = await previewChange(
      op("tasks.delete"),
      { projectId: "demo", taskId: id, detach: true },
      project,
    );
    expect(detached.details).toEqual(["1 subtasks will be detached", "status: draft"]);
    expect(detached.blocked).toBeUndefined();

    const archived = await previewChange(
      op("tasks.archive"),
      { projectId: "demo", taskId: child.frontmatter.id },
      project,
    );
    expect(archived.title).toBe(`Archive task "Child note" (${child.frontmatter.id})`);
    expect(archived.destructive).toBe(false);
    expect(archived.guard).toEqual({
      kind: "task",
      id: child.frontmatter.id,
      stamp: child.frontmatter.updated,
    });

    const queued = await previewChange(
      op("tasks.queue"),
      { projectId: "demo", taskId: id },
      project,
    );
    expect(queued.title).toBe(
      `Queue task "Fix readme" (${id}): the runner may start it and spend budget`,
    );
    expect(queued.destructive).toBe(false);

    const epicGone = await previewChange(
      op("epics.delete"),
      { projectId: "demo", epicId: epic.id },
      project,
    );
    expect(epicGone.title).toBe('Delete epic "Billing"');
    expect(epicGone.details).toEqual(["has 1 tasks; deleting is refused unless detach is set"]);
    expect(epicGone.destructive).toBe(true);
    expect(epicGone.blocked).toContain("has 1 task,");
    const epicDetached = await previewChange(
      op("epics.delete"),
      { projectId: "demo", epicId: epic.id, detach: true },
      project,
    );
    expect(epicDetached.blocked).toBeUndefined();
    expect(epicGone.guard).toEqual({ kind: "epic", id: epic.id, stamp: epic.updated });
  });

  it("previews goal removal and replacement from the stored plan", async () => {
    const plan = await project.plans.createPlan(
      {
        id: "demo-plan",
        title: "Demo plan",
        status: "draft",
        goals: [
          goal("alpha", "Alpha"),
          goal("beta", "Beta", "Build beta", ["alpha"]),
          goal("gamma", "Gamma"),
        ],
      },
      LOCAL_PRINCIPAL,
    );
    const alphaTask = await project.create({ title: "Do alpha", prompt: "p", status: "pending" });
    await project.tasks.modify(alphaTask.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "alpha", revision: 1 };
    });
    const done = await project.create({ title: "Done beta", prompt: "p", status: "pending" });
    await project.tasks.transition(done.frontmatter.id, "running");
    await project.tasks.transition(done.frontmatter.id, "done", (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "beta", revision: 1 };
    });

    const removed = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha", cascade: true },
      project,
    );
    expect(removed.title).toBe('Remove goal "Alpha" from plan "Demo plan"');
    expect(removed.details).toEqual([
      'Also removes goals: "Beta" (beta)',
      `Archives task "Do alpha" (${alphaTask.frontmatter.id})`,
    ]);
    expect(removed.destructive).toBe(true);
    expect(removed.guard).toEqual({ kind: "plan", id: plan.id, stamp: String(plan.version) });

    const replaced = await previewChange(
      op("plans.replaceGoals"),
      {
        projectId: "demo",
        planId: plan.id,
        goals: [
          goal("alpha", "Alpha", "Build alpha differently"),
          goal("gamma", "Gamma"),
          goal("delta", "Delta"),
        ],
      },
      project,
    );
    expect(replaced.title).toBe('Replace the goals of plan "Demo plan"');
    expect(replaced.details).toEqual(['Removed "Beta"', 'Changed "Alpha"', 'Added "Delta"']);
    expect(replaced.destructive).toBe(true);
    expect(replaced.guard).toEqual({ kind: "plan", id: plan.id, stamp: String(plan.version) });
  });

  it("describes write ops as a change and activating a plan", async () => {
    const task = await project.create({ title: "Fix readme", prompt: "p" });
    const parent = await project.create({ title: "Parent", prompt: "p" });
    const plan = await project.plans.createPlan(
      { id: "ship", title: "Ship", status: "draft", goals: [goal("alpha", "Alpha")] },
      LOCAL_PRINCIPAL,
    );

    const updated = await previewChange(
      op("tasks.update"),
      { projectId: "demo", taskId: task.frontmatter.id, title: "New title", priority: 3 },
      project,
    );
    expect(updated.title).toBe('Change task "Fix readme": title, priority');
    expect(updated.details).toEqual(['title: "Fix readme" → "New title"', "priority: 50 → 3"]);
    expect(updated.guard).toEqual({
      kind: "task",
      id: task.frontmatter.id,
      stamp: task.frontmatter.updated,
    });
    expect(updated.destructive).toBe(false);

    const moved = await previewChange(
      op("tasks.move"),
      { projectId: "demo", taskId: task.frontmatter.id, parentId: parent.frontmatter.id },
      project,
    );
    expect(moved.title).toBe('Change task "Fix readme": parentId');
    expect(moved.details).toEqual([`parentId: (none) → "${parent.frontmatter.id}"`]);

    const activated = await previewChange(
      op("plans.update"),
      { projectId: "demo", planId: plan.id, status: "active" },
      project,
    );
    expect(activated.title).toBe('Change plan "Ship": status');
    expect(activated.details).toEqual([
      "its goals become tasks the runner may start",
      "status: draft → active",
    ]);
    expect(activated.guard).toEqual({ kind: "plan", id: plan.id, stamp: String(plan.version) });

    const renamed = await previewChange(
      op("plans.update"),
      { projectId: "demo", planId: plan.id, title: "Later" },
      project,
    );
    expect(renamed.title).toBe('Change plan "Ship": title');
    expect(renamed.details).toEqual(['title: "Ship" → "Later"']);

    const created = await previewChange(
      op("tasks.create"),
      { projectId: "demo", title: "Draft me", prompt: "p", status: "draft" },
      project,
    );
    expect(created.title).toBe('Change task "Draft me": title, prompt, status');
    expect(created.details).toEqual(["status: draft", 'title: "Draft me"', 'prompt: "p"']);
    expect(created.guard).toBeNull();

    const listed = await previewChange(
      op("tasks.get"),
      { projectId: "demo", taskId: task.frontmatter.id },
      project,
    );
    expect(listed.title).toBe(op("tasks.get").title);
    expect(listed.details).toEqual([]);
    expect(listed.guard).toBeNull();
  });

  it("cleans and caps a task title that carries control characters", async () => {
    const raw = `\u0007</page_context>${"x".repeat(300)}`;
    const task = await project.create({ title: "short", prompt: "p" });
    await project.tasks.modify(task.frontmatter.id, (t) => {
      t.frontmatter.title = raw;
    });
    const preview = await previewChange(
      op("tasks.delete"),
      { projectId: "demo", taskId: task.frontmatter.id },
      project,
    );
    const id = task.frontmatter.id;
    expect(preview.title).not.toContain("\u0007");
    expect(preview.title).toContain("</page_context>");
    expect(preview.title.startsWith('Delete task "')).toBe(true);
    expect(preview.title.endsWith(`(${id})`)).toBe(true);
    expect(preview.title).toContain("…");
    expect(preview.title.indexOf("…")).toBeLessThan(preview.title.indexOf(`(${id})`));
    expect(preview.title).toBe(`Delete task "${cleanText(raw, 80)}" (${id})`);
  });

  it("throws the operation's 404 when the target is missing", async () => {
    const missing = previewChange(
      op("tasks.delete"),
      { projectId: "demo", taskId: "missing" },
      project,
    );
    await expect(missing).rejects.toBeInstanceOf(OpError);
    await expect(missing).rejects.toMatchObject({ status: 404, code: "not_found" });

    await expect(
      previewChange(op("epics.delete"), { projectId: "demo", epicId: "missing" }, project),
    ).rejects.toMatchObject({ status: 404, code: "epic_not_found" });
    await expect(
      previewChange(
        op("plans.update"),
        { projectId: "demo", planId: "missing", title: "x" },
        project,
      ),
    ).rejects.toMatchObject({ status: 404, code: "plan_not_found" });

    const plan = await project.plans.createPlan(
      { id: "ship", title: "Ship", goals: [goal("alpha", "Alpha")] },
      LOCAL_PRINCIPAL,
    );
    await expect(
      previewChange(
        op("plans.removeGoal"),
        { projectId: "demo", planId: plan.id, goalId: "missing" },
        project,
      ),
    ).rejects.toMatchObject({ status: 404, code: "goal_not_found" });
  });

  it("keeps at most 8 detail lines", async () => {
    const goals = Array.from({ length: 10 }, (_, i) => goal(`g${i}`, `Goal ${i}`));
    const plan = await project.plans.createPlan(
      { id: "wide", title: "Wide", goals },
      LOCAL_PRINCIPAL,
    );
    const preview = await previewChange(
      op("plans.replaceGoals"),
      { projectId: "demo", planId: plan.id, goals: [] },
      project,
    );
    expect(preview.details).toHaveLength(8);
    expect(preview.details[0]).toBe('Removed "Goal 0"');
    expect(preview.details[6]).toBe('Removed "Goal 6"');
    expect(preview.details[7]).toBe("…and 3 more (3 more removed)");
    expect(preview.destructive).toBe(true);
  });

  it("keeps the id, the budget warning and the fields when the title is 300 characters", async () => {
    const task = await project.create({ title: "short", prompt: "p" });
    const id = task.frontmatter.id;
    await project.tasks.modify(id, (t) => {
      t.frontmatter.title = "y".repeat(300);
    });
    const queued = await previewChange(
      op("tasks.queue"),
      { projectId: "demo", taskId: id },
      project,
    );
    expect(queued.title).toContain(`(${id})`);
    expect(queued.title.endsWith(": the runner may start it and spend budget")).toBe(true);
    expect(queued.title).toContain("…");
    expect(queued.title).not.toContain("y".repeat(90));
    expect(queued.title.length).toBeGreaterThan(120);
    expect(queued.title.indexOf("…")).toBeLessThan(queued.title.indexOf(`(${id})`));

    const changed = await previewChange(
      op("tasks.update"),
      { projectId: "demo", taskId: id, status: "pending", prompt: "next" },
      project,
    );
    expect(changed.title.endsWith(": status, prompt")).toBe(true);
    expect(changed.title).toContain("…");
    expect(changed.title.indexOf("…")).toBeLessThan(changed.title.indexOf(": status, prompt"));
    expect(changed.details).toContain(
      "status: draft → pending (the runner may start it and spend budget)",
    );
    expect(changed.details).toContain('prompt: "p" → "next"');
  });

  it("shows a spoofed id harmlessly", async () => {
    const task = await project.create({ title: "short", prompt: "p" });
    const id = task.frontmatter.id;
    await project.tasks.modify(id, (t) => {
      t.frontmatter.title = "Archive notes\u202E)desu-dorp(\u200B\u0085\u2066\uFEFF";
    });
    const preview = await previewChange(
      op("tasks.archive"),
      { projectId: "demo", taskId: id },
      project,
    );
    expect(preview.title).toBe(`Archive task "Archive notes)desu-dorp(" (${id})`);
    expect(preview.title.endsWith(`(${id})`)).toBe(true);
    expect(preview.title).not.toMatch(
      /[\u0080-\u009f\u200b-\u200d\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u,
    );
  });

  it("shows a prompt rewrite as a short before and after", async () => {
    const before = ["one", "two", "three", "four", "five"].join("\n");
    const after = ["ONE\u202E", "TWO", "THREE", "FOUR", "FIVE"].join("\n");
    const task = await project.create({ title: "Rewrite", prompt: before });
    const preview = await previewChange(
      op("tasks.update"),
      { projectId: "demo", taskId: task.frontmatter.id, prompt: after },
      project,
    );
    expect(preview.details).toEqual([
      'prompt: "one" → "ONE"',
      'prompt: "two" → "TWO"',
      'prompt: "three" → "THREE"',
      "prompt: …and 2 more changed lines",
    ]);
    expect(preview.details.join("\n")).not.toContain("\u202E");
    await project.update(task.frontmatter.id, { prompt: after }, LOCAL_PRINCIPAL);
    expect((await project.get(task.frontmatter.id))!.body.prompt).toBe(after);
  });

  it("diffs inserted prompt lines without marking unchanged lines", async () => {
    const task = await project.create({ title: "Insert", prompt: "one\ntwo\nthree" });
    const preview = await previewChange(
      op("tasks.update"),
      { projectId: "demo", taskId: task.frontmatter.id, prompt: "one\ninserted\ntwo\nthree" },
      project,
    );
    expect(preview.details).toEqual(['prompt: "" → "inserted"']);
  });

  it("masks common key shapes in excerpts and old/new values", async () => {
    const task = await project.create({ title: "Keys", prompt: "safe" });
    const secret = "sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwx";
    const preview = await previewChange(
      op("tasks.update"),
      { projectId: "demo", taskId: task.frontmatter.id, prompt: secret },
      project,
    );
    expect(preview.details.join("\n")).not.toContain("sk-ant-api03");
    expect(preview.details.join("\n")).not.toContain("ghp_");
    expect(preview.details.join("\n")).toContain("[REDACTED]");
  });

  it("keeps a pending status warning visible after many earlier input fields", async () => {
    const task = await project.create({ title: "Many fields", prompt: "old" });
    const preview = await previewChange(
      op("tasks.update"),
      {
        projectId: "demo",
        taskId: task.frontmatter.id,
        title: "New",
        prompt: "one\ntwo\nthree\nfour\nfive",
        priority: 3,
        labels: ["a"],
        runs: 4,
        skip: ["x"],
        status: "pending",
      },
      project,
    );
    expect(preview.details).toContain(
      "status: draft → pending (the runner may start it and spend budget)",
    );
  });

  it("shows a project brief rewrite and what confirming stores", async () => {
    await service.updateProject("demo", { brief: "old line\nkeep" }, LOCAL_PRINCIPAL);
    const next = "new line\nkeep\nextra";
    const preview = await previewChange(
      op("projects.update"),
      { projectId: "demo", brief: next },
      project,
    );
    expect(preview.title).toContain("brief");
    expect(preview.details[0]).toBe('brief: "old line" → "new line"');
    expect(preview.details).toContain('brief: "" → "extra"');
    await service.updateProject("demo", { brief: next }, LOCAL_PRINCIPAL);
    expect((await service.getProject("demo")).brief).toBe(next);
    expect(preview.details.join("\n")).toContain("old line");
    expect(preview.details.join("\n")).toContain("new line");
  });

  it("warns that turning auto-sync on for an active plan may run tasks", async () => {
    const live = await project.plans.createPlan(
      {
        id: "live",
        title: "Live",
        status: "active",
        autoSync: false,
        goals: [goal("alpha", "Alpha")],
      },
      LOCAL_PRINCIPAL,
    );
    const preview = await previewChange(
      op("plans.update"),
      { projectId: "demo", planId: live.id, autoSync: true },
      project,
    );
    expect(preview.details).toEqual([
      "tasks will be created and may run",
      "autoSync: false → true",
    ]);
    await project.plans.updatePlan(live.id, { autoSync: true }, live.version, LOCAL_PRINCIPAL);
    expect((await project.plans.get(live.id)).autoSync).toBe(true);

    const draft = await project.plans.createPlan(
      { id: "drafty", title: "Drafty", status: "draft", goals: [goal("alpha", "Alpha")] },
      LOCAL_PRINCIPAL,
    );
    const quiet = await previewChange(
      op("plans.update"),
      { projectId: "demo", planId: draft.id, autoSync: true },
      project,
    );
    expect(quiet.details).toEqual(["autoSync: false → true"]);
  });

  it("treats setting a task to pending as queueing it", async () => {
    const task = await project.create({ title: "Fix readme", prompt: "p" });
    const preview = await previewChange(
      op("tasks.update"),
      { projectId: "demo", taskId: task.frontmatter.id, status: "pending" },
      project,
    );
    expect(preview.details).toEqual([
      "status: draft → pending (the runner may start it and spend budget)",
    ]);
    await project.update(task.frontmatter.id, { status: "pending" }, LOCAL_PRINCIPAL);
    expect((await project.get(task.frontmatter.id))!.frontmatter.status).toBe("pending");
  });

  it("marks goal replacement destructive only when a goal is removed", async () => {
    const alpha = goal("alpha", "Alpha");
    const plan = await project.plans.createPlan(
      { id: "add-only", title: "Add", goals: [alpha] },
      LOCAL_PRINCIPAL,
    );
    const added = await previewChange(
      op("plans.replaceGoals"),
      { projectId: "demo", planId: plan.id, goals: [alpha, goal("beta", "Beta")] },
      project,
    );
    expect(added.destructive).toBe(false);
    expect(added.details).toEqual(['Added "Beta"']);
  });

  it("warns when replacing goals of an active auto-sync plan", async () => {
    const alpha = goal("alpha", "Alpha");
    const plan = await project.plans.createPlan(
      { id: "sync", title: "Sync", status: "active", autoSync: true, goals: [alpha] },
      LOCAL_PRINCIPAL,
    );
    const preview = await previewChange(
      op("plans.replaceGoals"),
      { projectId: "demo", planId: plan.id, goals: [alpha, goal("beta", "Beta")] },
      project,
    );
    expect(preview.details[0]).toBe("tasks will be created and may run");
    expect(preview.details).toContain('Added "Beta"');
    expect(preview.destructive).toBe(false);
  });

  it("keeps the auto-sync warning visible when removing many goals", async () => {
    const goals = Array.from({ length: 9 }, (_, i) => goal(`old${i}`, `Old ${i}`));
    const plan = await project.plans.createPlan(
      { id: "sync-many", title: "Sync many", status: "active", autoSync: true, goals },
      LOCAL_PRINCIPAL,
    );
    const preview = await previewChange(
      op("plans.replaceGoals"),
      { projectId: "demo", planId: plan.id, goals: [goal("new", "New")] },
      project,
    );
    expect(preview.details).toContain("tasks will be created and may run");
  });

  it("shows the removal when nine goals are added and one is removed", async () => {
    const kept = goal("keep", "Keep");
    const doomed = goal("pay", "Critical payment goal");
    const plan = await project.plans.createPlan(
      { id: "swap", title: "Swap", status: "draft", goals: [kept, doomed] },
      LOCAL_PRINCIPAL,
    );
    const added = Array.from({ length: 9 }, (_, i) => goal(`n${i}`, `New ${i}`));
    const goals = [kept, ...added];
    const preview = await previewChange(
      op("plans.replaceGoals"),
      { projectId: "demo", planId: plan.id, goals },
      project,
    );
    expect(preview.details[0]).toBe('Removed "Critical payment goal"');
    expect(preview.details[7]).toBe("…and 3 more (3 more added)");
    const text = [preview.title, ...preview.details].join("\n");
    const after = await project.plans.replaceGoals(plan.id, goals, plan.version, LOCAL_PRINCIPAL);
    const ids = new Set(after.goals.map((item) => item.id));
    for (const item of plan.goals) {
      if (!ids.has(item.id)) expect(text).toContain(item.title);
    }
    expect(ids.has("pay")).toBe(false);
    for (const item of added) expect(ids.has(item.id)).toBe(true);
  });

  it("names every goal cascade removes and every task the operation archives", async () => {
    const plan = await project.plans.createPlan(
      {
        id: "chain",
        title: "Chain",
        status: "draft",
        goals: [goal("alpha", "Alpha"), goal("beta", "Beta", "Build beta", ["alpha"])],
      },
      LOCAL_PRINCIPAL,
    );
    const alpha = await project.create({ title: "Do alpha", prompt: "p", status: "pending" });
    const beta = await project.create({ title: "Do beta", prompt: "p", status: "pending" });
    await project.tasks.modify(alpha.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "alpha", revision: 1 };
    });
    await project.tasks.modify(beta.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "beta", revision: 1 };
    });
    const preview = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha", cascade: true },
      project,
    );
    const text = [preview.title, ...preview.details].join("\n");
    expect((await project.get(alpha.frontmatter.id))!.frontmatter.status).toBe("pending");
    const after = await project.plans.removeGoal(plan.id, "alpha", plan.version, { cascade: true });
    expect(after.goals.map((item) => item.id)).toEqual([]);
    for (const item of plan.goals) expect(text).toContain(item.title);
    expect(text).toContain("(beta)");
    for (const id of [alpha.frontmatter.id, beta.frontmatter.id]) {
      expect(text).toContain(id);
      expect((await project.get(id))!.frontmatter.status).toBe("archived");
    }
  });

  it("lists leftover tasks from an earlier replacement that removeGoal archives", async () => {
    const alpha = goal("alpha", "Alpha");
    const gamma = goal("gamma", "Gamma");
    const plan = await project.plans.createPlan(
      { id: "left", title: "Left", status: "draft", goals: [alpha, gamma] },
      LOCAL_PRINCIPAL,
    );
    const alphaTask = await project.create({ title: "Do alpha", prompt: "p", status: "pending" });
    const gammaTask = await project.create({ title: "Do gamma", prompt: "p", status: "pending" });
    await project.tasks.modify(alphaTask.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "alpha", revision: 1 };
    });
    await project.tasks.modify(gammaTask.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "gamma", revision: 1 };
    });
    const replaced = await previewChange(
      op("plans.replaceGoals"),
      { projectId: "demo", planId: plan.id, goals: [alpha] },
      project,
    );
    expect(replaced.details.join("\n")).not.toContain("Archives");
    const next = await project.plans.replaceGoals(plan.id, [alpha], plan.version, LOCAL_PRINCIPAL);
    expect((await project.get(gammaTask.frontmatter.id))!.frontmatter.status).toBe("pending");

    const preview = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha" },
      project,
    );
    const text = [preview.title, ...preview.details].join("\n");
    await project.plans.removeGoal(plan.id, "alpha", next.version);
    for (const id of [alphaTask.frontmatter.id, gammaTask.frontmatter.id]) {
      expect(text).toContain(id);
      expect((await project.get(id))!.frontmatter.status).toBe("archived");
    }
  });

  it("names the running tasks stopRunning will stop", async () => {
    const plan = await project.plans.createPlan(
      { id: "run", title: "Run", status: "draft", goals: [goal("alpha", "Alpha")] },
      LOCAL_PRINCIPAL,
    );
    const pending = await project.create({ title: "Wait", prompt: "p", status: "pending" });
    const running = await project.create({ title: "Run me", prompt: "p", status: "pending" });
    const other = await project.create({ title: "Elsewhere", prompt: "p", status: "pending" });
    await project.tasks.transition(running.frontmatter.id, "running");
    await project.tasks.transition(other.frontmatter.id, "running");
    await project.tasks.modify(pending.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "alpha", revision: 1 };
    });
    await project.tasks.modify(running.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "alpha", revision: 1 };
    });
    const quiet = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha" },
      project,
    );
    expect(quiet.details.join("\n")).not.toContain("Stops");
    expect(quiet.details.join("\n")).not.toContain(running.frontmatter.id);
    expect(quiet.details.join("\n")).toContain(pending.frontmatter.id);

    const preview = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha", stopRunning: true },
      project,
    );
    const text = [preview.title, ...preview.details].join("\n");
    expect(text).toContain(`Stops running task "Run me" (${running.frontmatter.id})`);
    expect(text).toContain(pending.frontmatter.id);
    expect(text).not.toContain(other.frontmatter.id);
    await project.plans.removeGoal(plan.id, "alpha", plan.version, { stopRunning: true });
    expect((await project.get(pending.frontmatter.id))!.frontmatter.status).toBe("archived");
    expect((await project.get(running.frontmatter.id))!.frontmatter.status).toBe("running");
    expect(existsSync(taskStopRequestPath(project.root, running.frontmatter.id))).toBe(true);
    expect(existsSync(taskStopRequestPath(project.root, other.frontmatter.id))).toBe(false);
    expect(text).toContain(running.frontmatter.id);
  });

  it("warns that removing a goal with dependents fails unless cascade is set", async () => {
    const plan = await project.plans.createPlan(
      {
        id: "deps",
        title: "Deps",
        goals: [goal("alpha", "Alpha"), goal("beta", "Beta", "Build beta", ["alpha"])],
      },
      LOCAL_PRINCIPAL,
    );
    const task = await project.create({ title: "Do alpha", prompt: "p", status: "pending" });
    await project.tasks.modify(task.frontmatter.id, (t) => {
      t.frontmatter.planRef = { planId: plan.id, goalId: "alpha", revision: 1 };
    });
    const preview = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha" },
      project,
    );
    expect(preview.details).toEqual([
      'Confirming will fail with 409 goal_has_dependents: "Beta" (beta)',
    ]);
    expect(preview.blocked).toContain('Other goals depend on this goal ("Beta" (beta))');
    const cascaded = await previewChange(
      op("plans.removeGoal"),
      { projectId: "demo", planId: plan.id, goalId: "alpha", cascade: true },
      project,
    );
    expect(cascaded.blocked).toBeUndefined();
    await expect(project.plans.removeGoal(plan.id, "alpha", plan.version)).rejects.toMatchObject({
      status: 409,
      code: "goal_has_dependents",
    });
    expect((await project.plans.get(plan.id)).goals.map((item) => item.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect((await project.get(task.frontmatter.id))!.frontmatter.status).toBe("pending");
  });

  it("says an epic delete is refused without detach and clears the epic with it", async () => {
    const epic = await project.createEpic({ title: "Billing", id: "billing" });
    const task = await project.create({ title: "Invoice", prompt: "p", epicId: epic.id });
    const refused = await previewChange(
      op("epics.delete"),
      { projectId: "demo", epicId: epic.id },
      project,
    );
    expect(refused.details).toEqual(["has 1 tasks; deleting is refused unless detach is set"]);
    await expect(project.deleteEpic(epic.id, {})).rejects.toBeInstanceOf(HierarchyError);
    await expect(project.deleteEpic(epic.id, {})).rejects.toMatchObject({ code: "has_tasks" });
    expect((await project.get(task.frontmatter.id))!.frontmatter.epicId).toBe(epic.id);

    const detached = await previewChange(
      op("epics.delete"),
      { projectId: "demo", epicId: epic.id, detach: true },
      project,
    );
    expect(detached.details).toEqual(["1 tasks will lose their epic"]);
    await project.deleteEpic(epic.id, { detach: true });
    expect((await project.get(task.frontmatter.id))!.frontmatter.epicId).toBeUndefined();
  });
});
