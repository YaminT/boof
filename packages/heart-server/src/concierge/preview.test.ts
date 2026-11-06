import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand, LOCAL_PRINCIPAL, SettingsStore, defaultSettings } from "@boof/heart";
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
  rules: { do: ["Write a failing test first."] },
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
      "status: draft",
      "has 1 subtasks; deleting is refused unless detach is set",
    ]);
    expect(deleted.destructive).toBe(true);
    expect(deleted.guard).toEqual({ kind: "task", id, stamp: task.frontmatter.updated });

    const detached = await previewChange(
      op("tasks.delete"),
      { projectId: "demo", taskId: id, detach: true },
      project,
    );
    expect(detached.details).toEqual(["status: draft", "1 subtasks will be detached"]);

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
    expect(epicGone.details).toEqual(["1 tasks in it"]);
    expect(epicGone.destructive).toBe(true);
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
    expect(removed.details).toEqual([`Archives task "Do alpha" (${alphaTask.frontmatter.id})`]);
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
    expect(replaced.details).toEqual(['Added "Delta"', 'Removed "Beta"', 'Changed "Alpha"']);
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

    const activated = await previewChange(
      op("plans.update"),
      { projectId: "demo", planId: plan.id, status: "active" },
      project,
    );
    expect(activated.title).toBe('Change plan "Ship": status');
    expect(activated.details).toEqual(["its goals become tasks the runner may start"]);
    expect(activated.guard).toEqual({ kind: "plan", id: plan.id, stamp: String(plan.version) });

    const renamed = await previewChange(
      op("plans.update"),
      { projectId: "demo", planId: plan.id, title: "Later" },
      project,
    );
    expect(renamed.title).toBe('Change plan "Ship": title');
    expect(renamed.details).toEqual([]);

    const created = await previewChange(
      op("tasks.create"),
      { projectId: "demo", title: "Draft me", prompt: "p", status: "draft" },
      project,
    );
    expect(created.title).toBe('Change task "Draft me": title, prompt, status');
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
    expect(preview.title).not.toContain("\u0007");
    expect(preview.title).toContain("</page_context>");
    expect(preview.title.startsWith('Delete task "')).toBe(true);
    expect(preview.title.endsWith("…")).toBe(true);
    expect(preview.title.length).toBeLessThanOrEqual(120);
    expect(preview.details.every((line) => line.length <= 120)).toBe(true);
    expect(preview.title).toBe(
      cleanText(`Delete task "${cleanText(raw)}" (${task.frontmatter.id})`),
    );
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
    expect(preview.details[7]).toBe('Removed "Goal 7"');
  });
});
