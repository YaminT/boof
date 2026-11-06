import {
  EpicError,
  sameGoalContent,
  type Goal,
  type GoalSpec,
  type PendingChange,
} from "@boof/heart";
import type { AnyOperation } from "../api/define-op.js";
import { OpError } from "../api/errors.js";
import type { ProjectService } from "../api/services/service.js";

export interface ChangePreview {
  title: string;
  details: string[];
  destructive: boolean;
  guard: PendingChange["guard"];
}

const DETAIL_CAP = 8;

const SKIP_FIELDS = new Set([
  "projectId",
  "taskId",
  "planId",
  "epicId",
  "goalId",
  "expectedUpdated",
  "expectedVersion",
  "id",
]);

/** Write ops whose preview is `Change <kind> "<title>": <field list>`. */
const CHANGE_KIND: Record<string, "task" | "plan" | "epic" | "goal"> = {
  "tasks.create": "task",
  "tasks.update": "task",
  "tasks.move": "task",
  "epics.create": "epic",
  "epics.update": "epic",
  "plans.create": "plan",
  "plans.update": "plan",
  "plans.upsertGoal": "goal",
  "plans.reorderGoals": "plan",
  "plans.setGoalStatus": "goal",
};

interface GoalLike {
  id: string;
  title: string;
  spec?: GoalSpec;
  dependsOn?: string[];
  model?: string;
  status?: string;
}

/**
 * Strip control characters, collapse whitespace, and cap the result (default 120) with "…".
 */
export function cleanText(value: string, max = 120): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  if (max < 1) return "";
  return `${cleaned.slice(0, max - 1)}…`;
}

/** A server-computed preview. A missing target throws that operation's 404 code. */
export async function previewChange(
  op: AnyOperation,
  input: Record<string, unknown>,
  project: ProjectService,
): Promise<ChangePreview> {
  const destructive = op.mcp.annotations?.destructiveHint === true;
  const preview = await buildPreview(op, input, project, destructive);
  return {
    ...preview,
    title: cleanText(preview.title),
    details: preview.details.slice(0, DETAIL_CAP).map((line) => cleanText(line)),
  };
}

async function buildPreview(
  op: AnyOperation,
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<ChangePreview> {
  switch (op.name) {
    case "tasks.delete":
      return deleteTask(input, project, destructive);
    case "tasks.archive":
      return taskLine(input, project, destructive, "Archive task");
    case "tasks.queue":
      return taskLine(
        input,
        project,
        destructive,
        "Queue task",
        ": the runner may start it and spend budget",
      );
    case "epics.delete":
      return deleteEpic(input, project, destructive);
    case "plans.removeGoal":
      return removeGoal(input, project, destructive);
    case "plans.replaceGoals":
      return replaceGoals(input, project, destructive);
    default:
      break;
  }
  const kind = CHANGE_KIND[op.name];
  if (kind) return changeOp(kind, op.name, input, project, destructive);
  return { title: op.title, details: [], destructive, guard: null };
}

function fieldList(input: Record<string, unknown>): string {
  return Object.keys(input)
    .filter((key) => !SKIP_FIELDS.has(key) && input[key] !== undefined)
    .join(", ");
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function changeTitle(kind: string, title: string, input: Record<string, unknown>): string {
  const fields = fieldList(input);
  const name = cleanText(title);
  return fields ? `Change ${kind} "${name}": ${fields}` : `Change ${kind} "${name}"`;
}

async function requireTask(project: ProjectService, id: string) {
  const task = id ? await project.get(id) : null;
  if (!task) throw new OpError(404, `Task not found: ${id}`, "not_found");
  return task;
}

async function requireEpic(project: ProjectService, id: string) {
  try {
    return await project.getEpic(id);
  } catch (err) {
    if (err instanceof EpicError && err.code === "not_found") {
      throw new OpError(404, err.message, "epic_not_found");
    }
    throw err;
  }
}

function taskGuard(task: { frontmatter: { id: string; updated: string } }): PendingChange["guard"] {
  return { kind: "task", id: task.frontmatter.id, stamp: task.frontmatter.updated };
}

async function taskLine(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
  verb: string,
  suffix = "",
): Promise<ChangePreview> {
  const task = await requireTask(project, text(input, "taskId"));
  const title = cleanText(task.frontmatter.title);
  return {
    title: `${verb} "${title}" (${task.frontmatter.id})${suffix}`,
    details: [],
    destructive,
    guard: taskGuard(task),
  };
}

async function deleteTask(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<ChangePreview> {
  const task = await requireTask(project, text(input, "taskId"));
  const id = task.frontmatter.id;
  const kids = (await project.list()).filter((item) => item.frontmatter.parentId === id);
  const details = [`status: ${task.frontmatter.status}`];
  if (kids.length > 0) {
    details.push(
      input.detach === true
        ? `${kids.length} subtasks will be detached`
        : `has ${kids.length} subtasks; deleting is refused unless detach is set`,
    );
  }
  const title = cleanText(task.frontmatter.title);
  return {
    title: `Delete task "${title}" (${id})`,
    details,
    destructive,
    guard: taskGuard(task),
  };
}

async function deleteEpic(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<ChangePreview> {
  const id = text(input, "epicId");
  const epic = await requireEpic(project, id);
  const count = (await project.list()).filter((task) => task.frontmatter.epicId === id).length;
  return {
    title: `Delete epic "${cleanText(epic.title)}"`,
    details: [`${count} tasks in it`],
    destructive,
    guard: { kind: "epic", id: epic.id, stamp: epic.updated },
  };
}

function doomedGoalIds(goals: Goal[], goalId: string, cascade: boolean): Set<string> {
  const doomed = new Set([goalId]);
  if (!cascade) return doomed;
  let grew = true;
  while (grew) {
    grew = false;
    for (const goal of goals) {
      if (!doomed.has(goal.id) && goal.dependsOn.some((dep) => doomed.has(dep))) {
        doomed.add(goal.id);
        grew = true;
      }
    }
  }
  return doomed;
}

async function removeGoal(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<ChangePreview> {
  const plan = await project.plans.get(text(input, "planId"));
  const goalId = text(input, "goalId");
  const goal = plan.goals.find((item) => item.id === goalId);
  if (!goal) throw new OpError(404, `Goal not found: ${goalId}`, "goal_not_found");
  const doomed = doomedGoalIds(plan.goals, goalId, input.cascade === true);
  const details: string[] = [];
  for (const task of await project.list()) {
    const ref = task.frontmatter.planRef;
    if (!ref || ref.planId !== plan.id || !doomed.has(ref.goalId)) continue;
    const status = task.frontmatter.status;
    if (status !== "draft" && status !== "pending") continue;
    details.push(`Archives task "${cleanText(task.frontmatter.title)}" (${task.frontmatter.id})`);
  }
  return {
    title: `Remove goal "${cleanText(goal.title)}" from plan "${cleanText(plan.title)}"`,
    details,
    destructive,
    guard: { kind: "plan", id: plan.id, stamp: String(plan.version) },
  };
}

function asGoals(input: Record<string, unknown>): GoalLike[] {
  if (!Array.isArray(input.goals)) return [];
  const out: GoalLike[] = [];
  for (const item of input.goals) {
    if (!item || typeof item !== "object") continue;
    const goal = item as Record<string, unknown>;
    if (typeof goal.id !== "string" || typeof goal.title !== "string") continue;
    out.push({
      id: goal.id,
      title: goal.title,
      ...(goal.spec && typeof goal.spec === "object" ? { spec: goal.spec as GoalSpec } : {}),
      ...(Array.isArray(goal.dependsOn) ? { dependsOn: goal.dependsOn as string[] } : {}),
      ...(typeof goal.model === "string" ? { model: goal.model } : {}),
      ...(typeof goal.status === "string" ? { status: goal.status } : {}),
    });
  }
  return out;
}

function goalContent(spec: GoalSpec, dependsOn: string[] | undefined, model: string | undefined) {
  return {
    spec: {
      ...spec,
      rules: { do: spec.rules?.do ?? [], dont: spec.rules?.dont ?? [] },
    },
    dependsOn: dependsOn ?? [],
    model,
  };
}

function goalChanged(before: Goal, after: GoalLike): boolean {
  if (after.title !== before.title) return true;
  if (after.status !== undefined && after.status !== before.status) return true;
  if (!after.spec) return false;
  return !sameGoalContent(
    goalContent(before.spec, before.dependsOn, before.model),
    goalContent(after.spec, after.dependsOn, after.model),
  );
}

async function replaceGoals(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<ChangePreview> {
  const plan = await project.plans.get(text(input, "planId"));
  const next = asGoals(input);
  const before = new Map(plan.goals.map((goal) => [goal.id, goal]));
  const afterIds = new Set(next.map((goal) => goal.id));
  const details: string[] = [];
  for (const goal of next) {
    if (!before.has(goal.id)) details.push(`Added "${cleanText(goal.title)}"`);
  }
  for (const goal of plan.goals) {
    if (!afterIds.has(goal.id)) details.push(`Removed "${cleanText(goal.title)}"`);
  }
  for (const goal of next) {
    const old = before.get(goal.id);
    if (old && goalChanged(old, goal)) details.push(`Changed "${cleanText(goal.title)}"`);
  }
  return {
    title: `Replace the goals of plan "${cleanText(plan.title)}"`,
    details,
    destructive,
    guard: { kind: "plan", id: plan.id, stamp: String(plan.version) },
  };
}

async function changeOp(
  kind: "task" | "plan" | "epic" | "goal",
  name: string,
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<ChangePreview> {
  if (name === "tasks.create" || name === "epics.create" || name === "plans.create") {
    return {
      title: changeTitle(kind, text(input, "title"), input),
      details: [],
      destructive,
      guard: null,
    };
  }
  if (kind === "task") {
    const task = await requireTask(project, text(input, "taskId"));
    return {
      title: changeTitle("task", task.frontmatter.title, input),
      details: [],
      destructive,
      guard: taskGuard(task),
    };
  }
  if (kind === "epic") {
    const epic = await requireEpic(project, text(input, "epicId"));
    return {
      title: changeTitle("epic", epic.title, input),
      details: [],
      destructive,
      guard: { kind: "epic", id: epic.id, stamp: epic.updated },
    };
  }
  const plan = await project.plans.get(text(input, "planId"));
  const guard: PendingChange["guard"] = {
    kind: "plan",
    id: plan.id,
    stamp: String(plan.version),
  };
  if (name === "plans.setGoalStatus" || name === "plans.upsertGoal") {
    const goalId = text(input, "goalId");
    const goal = plan.goals.find((item) => item.id === goalId);
    if (name === "plans.setGoalStatus" && !goal) {
      throw new OpError(404, `Goal not found: ${goalId}`, "goal_not_found");
    }
    const title = goal?.title ?? text(input, "title");
    return { title: changeTitle("goal", title, input), details: [], destructive, guard };
  }
  const details: string[] = [];
  if (name === "plans.update" && input.status === "active" && plan.status !== "active") {
    details.push("its goals become tasks the runner may start");
  }
  return {
    title: changeTitle("plan", plan.title, input),
    details,
    destructive,
    guard,
  };
}
