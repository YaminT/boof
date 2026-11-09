import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EpicError,
  ProjectSchema,
  archiveRemovedGoalTasks,
  sameGoalContent,
  type Goal,
  type GoalSpec,
  type PendingChange,
  type Plan,
  type Project,
  type Task,
} from "@boof/heart";
import type { AnyOperation } from "../api/define-op.js";
import { OpError } from "../api/errors.js";
import type { ProjectService } from "../api/services/service.js";

export interface ChangePreview {
  title: string;
  details: string[];
  destructive: boolean;
  /** Why confirming can only fail (a refusal the operation will make); the UI offers no Confirm. */
  blocked?: string;
  guard: PendingChange["guard"];
}

const DETAIL_CAP = 8;
/** Titles and single values. The id, the warnings and the field list stay outside this cap. */
const PART_MAX = 80;
const PROSE_LINES = 3;

const RUNNER_QUEUE = "the runner may start it and spend budget";
const RUNNER_ACTIVATION = "its goals become tasks the runner may start";
const RUNNER_SYNC = "tasks will be created and may run";

const SKIP_FIELDS = new Set([
  "projectId",
  "taskId",
  "planId",
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

const PROSE_FIELDS = new Set(["prompt", "brief", "description", "spec"]);

type DetailKind = "removed" | "changed" | "added" | "stopped" | "archived" | "warning" | "field";

interface Detail {
  kind: DetailKind;
  text: string;
}

interface Built {
  title: string;
  details: Detail[];
  destructive: boolean;
  blocked?: string;
  guard: PendingChange["guard"];
}

interface GoalLike {
  id: string;
  title: string;
  spec?: GoalSpec;
  dependsOn?: string[];
  model?: string;
  status?: string;
}

const KIND_ORDER: DetailKind[] = [
  "removed",
  "changed",
  "added",
  "stopped",
  "archived",
  "warning",
  "field",
];

/**
 * Strip control and format characters, collapse whitespace, and cap the result
 * (default 120) with "…". Format characters are removed so a title cannot reverse
 * or hide the id that follows it.
 */
export function cleanText(value: string, max = 120): string {
  const cleaned = sanitize(value);
  if (cleaned.length <= max) return cleaned;
  if (max < 1) return "";
  return `${cleaned.slice(0, max - 1)}…`;
}

function sanitize(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return cleanText(value, PART_MAX);
}

/** A server-computed preview. A missing target throws that operation's 404 code. */
export async function previewChange(
  op: AnyOperation,
  input: Record<string, unknown>,
  project: ProjectService,
): Promise<ChangePreview> {
  const hinted = op.mcp.annotations?.destructiveHint === true;
  const preview = await buildPreview(op, input, project, hinted);
  return {
    title: sanitize(preview.title),
    details: capDetails(preview.details),
    destructive: preview.destructive,
    ...(preview.blocked ? { blocked: sanitize(preview.blocked) } : {}),
    guard: preview.guard,
  };
}

function capDetails(details: Detail[]): string[] {
  const lines = details
    .map((detail) => ({ kind: detail.kind, text: sanitize(detail.text) }))
    .sort((a, b) => {
      const rank = (line: Detail) =>
        line.kind === "warning"
          ? 0
          : line.text.startsWith("status:")
            ? 1
            : KIND_ORDER.indexOf(line.kind) + 2;
      return rank(a) - rank(b);
    });
  if (lines.length <= DETAIL_CAP) return lines.map((line) => line.text);
  const critical = lines.filter(
    (line) => line.kind === "warning" || line.text.startsWith("status:"),
  );
  const ordinary = lines.filter(
    (line) => line.kind !== "warning" && !line.text.startsWith("status:"),
  );
  const room = Math.max(0, DETAIL_CAP - critical.length - 1);
  const kept = [...critical, ...ordinary.slice(0, room)];
  const rest = ordinary.slice(room);
  if (rest.length === 0) return kept.map((line) => line.text);
  const counts = new Map<string, number>();
  for (const line of rest) counts.set(line.kind, (counts.get(line.kind) ?? 0) + 1);
  const parts: string[] = [];
  const seen = new Set<string>();
  const label = (kind: string, n: number) => {
    if (n === 1) return kind;
    if (kind === "warning") return "warnings";
    if (kind === "field") return "fields";
    return kind;
  };
  for (const kind of KIND_ORDER) {
    const n = counts.get(kind);
    if (!n) continue;
    seen.add(kind);
    parts.push(`${n} more ${label(kind, n)}`);
  }
  for (const [kind, n] of counts) {
    if (seen.has(kind)) continue;
    parts.push(`${n} more ${label(kind, n)}`);
  }
  return [...kept.map((line) => line.text), `…and ${rest.length} more (${parts.join(", ")})`];
}

async function buildPreview(
  op: AnyOperation,
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<Built> {
  switch (op.name) {
    case "tasks.delete":
      return deleteTask(input, project, destructive);
    case "tasks.archive":
      return taskLine(input, project, destructive, "Archive task");
    case "tasks.queue":
      return taskLine(input, project, destructive, "Queue task", `: ${RUNNER_QUEUE}`);
    case "epics.delete":
      return deleteEpic(input, project, destructive);
    case "plans.removeGoal":
      return removeGoal(input, project, destructive);
    case "plans.replaceGoals":
      return replaceGoals(input, project, destructive);
    case "projects.update":
      return describeProject(input, project, destructive);
    default:
      break;
  }
  const kind = CHANGE_KIND[op.name];
  if (kind) return changeOp(kind, op.name, input, project, destructive);
  return { title: op.title, details: [], destructive, guard: null };
}

function fieldList(name: string, input: Record<string, unknown>): string {
  return Object.keys(input)
    .filter((key) => !isSkipped(name, key) && input[key] !== undefined)
    .join(", ");
}

function isSkipped(name: string, key: string): boolean {
  if (SKIP_FIELDS.has(key)) return true;
  // epicId names the epic being edited. On a task it is the epic being assigned.
  if (key === "epicId" && name.startsWith("epics.")) return true;
  return false;
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function changeTitle(
  kind: string,
  title: string,
  name: string,
  input: Record<string, unknown>,
): string {
  const fields = fieldList(name, input);
  const label = cleanTitle(title);
  return fields ? `Change ${kind} "${label}": ${fields}` : `Change ${kind} "${label}"`;
}

function quoteLine(line: string): string {
  return `"${maskedText(line, PART_MAX)}"`;
}

function maskSecrets(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]{12,}/g, redact)
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, redact)
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, redact)
    .replace(/xox[abp]-[A-Za-z0-9-]{12,}/g, redact)
    .replace(/AKIA[0-9A-Z]{16}/g, redact)
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, (match) =>
      match.length === 40 || match.length === 64 ? match : redact(match),
    )
    .replace(/\b[A-Za-z0-9+]{40,}={0,2}\b/g, (match) =>
      /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match) ? redact(match) : match,
    );
}

function redact(secret: string): string {
  return `[REDACTED ${secret.length} chars]`;
}

function maskedText(value: string, max: number): string {
  return cleanText(maskSecrets(sanitize(value)), max);
}

function proseLines(body: string): string[] {
  const lines = body.split("\n");
  const shown = lines.slice(0, PROSE_LINES).map(quoteLine);
  if (lines.length > PROSE_LINES) shown.push(`…and ${lines.length - PROSE_LINES} more lines`);
  return shown;
}

function proseDiff(before: string, after: string): string[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const lcs = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (j < newLines.length && (i === oldLines.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      added.push(newLines[j++]);
    } else {
      removed.push(oldLines[i++]);
    }
  }
  const changed = Array.from({ length: Math.max(removed.length, added.length) }, (_, index) => ({
    old: removed[index] ?? "",
    neu: added[index] ?? "",
  }));
  if (changed.length === 0) return [];
  const shown = changed
    .slice(0, PROSE_LINES)
    .map((line) => `${quoteLine(line.old)} → ${quoteLine(line.neu)}`);
  if (changed.length > PROSE_LINES) {
    shown.push(`…and ${changed.length - PROSE_LINES} more changed lines`);
  }
  return shown;
}

function sameValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `"${maskedText(value, PART_MAX)}"`;
  if (
    Array.isArray(value) &&
    value.every((item) => ["string", "number", "boolean"].includes(typeof item))
  ) {
    if (value.length === 0) return "(none)";
    return maskedText(value.map(String).join(", "), PART_MAX);
  }
  return `"${maskedText(JSON.stringify(value) ?? "", PART_MAX)}"`;
}

function pushField(
  details: Detail[],
  field: string,
  before: unknown,
  after: unknown,
  mode: "create" | "update",
): void {
  if (field === "anthropicApiKey") {
    details.push({
      kind: "field",
      text: after === null ? "anthropicApiKey: removed" : "anthropicApiKey: set",
    });
    return;
  }
  if (mode === "update" && sameValue(before, after)) return;
  if (PROSE_FIELDS.has(field)) {
    const next =
      typeof after === "string"
        ? after
        : after === undefined || after === null
          ? ""
          : JSON.stringify(after, null, 2);
    const prev =
      typeof before === "string"
        ? before
        : before === undefined || before === null
          ? ""
          : JSON.stringify(before, null, 2);
    const lines = mode === "create" ? proseLines(next) : proseDiff(prev, next);
    for (const line of lines) details.push({ kind: "field", text: `${field}: ${line}` });
    return;
  }
  if (field === "status" && typeof after === "string") {
    const next = sanitize(after);
    const warn = next === "pending" ? ` (${RUNNER_QUEUE})` : "";
    const from = typeof before === "string" ? sanitize(before) : "";
    const text = mode === "create" ? `status: ${next}${warn}` : `status: ${from} → ${next}${warn}`;
    details.push({ kind: "field", text });
    return;
  }
  const text =
    mode === "create"
      ? `${field}: ${showValue(after)}`
      : `${field}: ${showValue(before)} → ${showValue(after)}`;
  details.push({ kind: "field", text });
}

function eachField(
  details: Detail[],
  name: string,
  input: Record<string, unknown>,
  mode: "create" | "update",
  current: (key: string) => unknown,
): void {
  for (const key of Object.keys(input)) {
    if (isSkipped(name, key) || input[key] === undefined) continue;
    pushField(details, key, current(key), input[key], mode);
  }
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

async function readProject(project: ProjectService): Promise<Project> {
  const path = join(project.root, "project.json");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OpError(404, `Project not found: ${project.projectId}`, "project_not_found");
    }
    throw err;
  }
  return ProjectSchema.parse(JSON.parse(body));
}

/** The assistant may only reword the description (the project's `brief`); policy refuses the rest. */
async function describeProject(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<Built> {
  const record = await readProject(project);
  const details: Detail[] = [];
  pushField(details, "brief", record.brief ?? "", text(input, "brief"), "update");
  return {
    title: `Change the description of project "${cleanTitle(record.name)}"`,
    details,
    destructive,
    guard: { kind: "project", id: record.id, stamp: record.updated },
  };
}

function taskGuard(task: { frontmatter: { id: string; updated: string } }): PendingChange["guard"] {
  return { kind: "task", id: task.frontmatter.id, stamp: task.frontmatter.updated };
}

function taskValue(task: Task, key: string): unknown {
  if (key === "prompt") return task.body.prompt;
  return (task.frontmatter as unknown as Record<string, unknown>)[key];
}

async function taskLine(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
  verb: string,
  suffix = "",
): Promise<Built> {
  const task = await requireTask(project, text(input, "taskId"));
  const title = cleanTitle(task.frontmatter.title);
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
): Promise<Built> {
  const task = await requireTask(project, text(input, "taskId"));
  const id = task.frontmatter.id;
  const kids = (await project.list()).filter((item) => item.frontmatter.parentId === id);
  const details: Detail[] = [{ kind: "field", text: `status: ${task.frontmatter.status}` }];
  if (kids.length > 0) {
    details.push({
      kind: "warning",
      text:
        input.detach === true
          ? `${kids.length} subtasks will be detached`
          : `has ${kids.length} subtasks; deleting is refused unless detach is set`,
    });
  }
  return {
    title: `Delete task "${cleanTitle(task.frontmatter.title)}" (${id})`,
    details,
    destructive,
    ...(kids.length > 0 && input.detach !== true
      ? {
          blocked: `This task has ${kids.length} ${kids.length === 1 ? "subtask" : "subtasks"}, so it cannot be deleted as proposed. Detaching subtasks is your decision: delete the task yourself from its page.`,
        }
      : {}),
    guard: taskGuard(task),
  };
}

async function deleteEpic(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<Built> {
  const id = text(input, "epicId");
  const epic = await requireEpic(project, id);
  const count = (await project.list()).filter((task) => task.frontmatter.epicId === id).length;
  let line: string;
  if (count === 0) line = "0 tasks in it";
  else if (input.detach === true) line = `${count} tasks will lose their epic`;
  else line = `has ${count} tasks; deleting is refused unless detach is set`;
  return {
    title: `Delete epic "${cleanTitle(epic.title)}"`,
    details: [{ kind: "warning", text: line }],
    destructive,
    ...(count > 0 && input.detach !== true
      ? {
          blocked: `This epic has ${count} ${count === 1 ? "task" : "tasks"}, so it cannot be deleted as proposed. Detaching them is your decision: delete the epic yourself.`,
        }
      : {}),
    guard: { kind: "epic", id: epic.id, stamp: epic.updated },
  };
}

/** Downstream ids in the order removeGoal discovers them, which is the 409's order. */
function dependentIds(goals: Goal[], goalId: string): string[] {
  const doomed = new Set([goalId]);
  const found: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const goal of goals) {
      if (!doomed.has(goal.id) && goal.dependsOn.some((dep) => doomed.has(dep))) {
        doomed.add(goal.id);
        found.push(goal.id);
        grew = true;
      }
    }
  }
  return found;
}

function goalLabel(goal: Goal): string {
  return `"${cleanTitle(goal.title)}" (${goal.id})`;
}

async function removeGoal(
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<Built> {
  const plan = await project.plans.get(text(input, "planId"));
  const goalId = text(input, "goalId");
  const goal = plan.goals.find((item) => item.id === goalId);
  if (!goal) throw new OpError(404, `Goal not found: ${goalId}`, "goal_not_found");
  const cascade = input.cascade === true;
  const dependents = dependentIds(plan.goals, goalId);
  const doomed = new Set([goalId, ...(cascade ? dependents : [])]);
  const byId = new Map(plan.goals.map((item) => [item.id, item]));
  const names = dependents
    .slice(0, 5)
    .map((id) => goalLabel(byId.get(id)!))
    .join(", ");
  const moreNames = dependents.length > 5 ? `, +${dependents.length - 5} more` : "";
  const title = `Remove goal "${cleanTitle(goal.title)}" from plan "${cleanTitle(plan.title)}"`;
  const guard: PendingChange["guard"] = {
    kind: "plan",
    id: plan.id,
    stamp: String(plan.version),
  };
  // The operation throws before it archives anything.
  if (!cascade && dependents.length > 0) {
    return {
      title,
      details: [
        {
          kind: "warning",
          text: `Confirming will fail with 409 goal_has_dependents: ${names}${moreNames}`,
        },
      ],
      destructive,
      blocked: `Other goals depend on this goal (${names}${moreNames}), so it cannot be removed as proposed. Removing them too is your decision: edit the plan yourself.`,
      guard,
    };
  }
  const details: Detail[] = [];
  if (cascade && dependents.length > 0) {
    details.push({ kind: "removed", text: `Also removes goals: ${names}${moreNames}` });
  }
  // No mayArchive or mayStop filter: that narrowing is the user's, and apply does it.
  // Listing every task here overstates a review-trust user; it never hides an effect.
  const tasks = await project.list();
  const nextPlan: Plan = { ...plan, goals: plan.goals.filter((item) => !doomed.has(item.id)) };
  const effects = await archiveRemovedGoalTasks({
    projectDir: project.root,
    plan: nextPlan,
    tasks,
    stopRunning: input.stopRunning === true,
    dryRun: true,
  });
  const titled = new Map(tasks.map((task) => [task.frontmatter.id, task.frontmatter.title]));
  const labelOf = (taskId: string) => `"${cleanTitle(titled.get(taskId) ?? taskId)}" (${taskId})`;
  for (const effect of effects) {
    if (effect.action !== "stop-requested") continue;
    details.push({ kind: "stopped", text: `Stops running task ${labelOf(effect.taskId)}` });
  }
  for (const effect of effects) {
    if (effect.action !== "archived") continue;
    details.push({ kind: "archived", text: `Archives task ${labelOf(effect.taskId)}` });
  }
  return { title, details, destructive, guard };
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
): Promise<Built> {
  const plan = await project.plans.get(text(input, "planId"));
  const next = asGoals(input);
  const before = new Map(plan.goals.map((goal) => [goal.id, goal]));
  const afterIds = new Set(next.map((goal) => goal.id));
  const details: Detail[] = [];
  for (const goal of plan.goals) {
    if (!afterIds.has(goal.id)) {
      details.push({ kind: "removed", text: `Removed "${cleanTitle(goal.title)}"` });
    }
  }
  if (plan.status === "active" && plan.autoSync) {
    details.push({ kind: "warning", text: RUNNER_SYNC });
  }
  for (const goal of next) {
    const old = before.get(goal.id);
    if (old && goalChanged(old, goal)) {
      details.push({ kind: "changed", text: `Changed "${cleanTitle(goal.title)}"` });
    }
  }
  for (const goal of next) {
    if (!before.has(goal.id)) {
      details.push({ kind: "added", text: `Added "${cleanTitle(goal.title)}"` });
    }
  }
  const removed = plan.goals.filter((goal) => !afterIds.has(goal.id)).length;
  return {
    title: `Replace the goals of plan "${cleanTitle(plan.title)}"`,
    details,
    destructive: destructive || removed > 0,
    guard: { kind: "plan", id: plan.id, stamp: String(plan.version) },
  };
}

function syncWarning(plan: Plan): Detail | null {
  return plan.status === "active" && plan.autoSync ? { kind: "warning", text: RUNNER_SYNC } : null;
}

async function changeOp(
  kind: "task" | "plan" | "epic" | "goal",
  name: string,
  input: Record<string, unknown>,
  project: ProjectService,
  destructive: boolean,
): Promise<Built> {
  if (name === "tasks.create" || name === "epics.create" || name === "plans.create") {
    const details: Detail[] = [];
    eachField(details, name, input, "create", () => undefined);
    return {
      title: changeTitle(kind, text(input, "title"), name, input),
      details,
      destructive,
      guard: null,
    };
  }
  if (kind === "task") {
    const task = await requireTask(project, text(input, "taskId"));
    const details: Detail[] = [];
    eachField(details, name, input, "update", (key) => taskValue(task, key));
    return {
      title: changeTitle("task", task.frontmatter.title, name, input),
      details,
      destructive,
      guard: taskGuard(task),
    };
  }
  if (kind === "epic") {
    const epic = await requireEpic(project, text(input, "epicId"));
    const details: Detail[] = [];
    eachField(
      details,
      name,
      input,
      "update",
      (key) => (epic as unknown as Record<string, unknown>)[key],
    );
    return {
      title: changeTitle("epic", epic.title, name, input),
      details,
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
    const details: Detail[] = [];
    const warning = syncWarning(plan);
    if (warning) details.push(warning);
    const current = (key: string): unknown =>
      goal ? (goal as unknown as Record<string, unknown>)[key] : undefined;
    eachField(details, name, input, goal ? "update" : "create", current);
    const title = goal?.title ?? text(input, "title");
    return { title: changeTitle("goal", title, name, input), details, destructive, guard };
  }
  const details: Detail[] = [];
  if (name === "plans.reorderGoals") {
    const warning = syncWarning(plan);
    if (warning) details.push(warning);
  }
  eachField(details, name, input, "update", (key) => {
    if (key === "order") return [...plan.goals].sort((a, b) => a.order - b.order).map((g) => g.id);
    return (plan as unknown as Record<string, unknown>)[key];
  });
  if (name === "plans.update" && input.status === "active" && plan.status !== "active") {
    details.push({ kind: "warning", text: RUNNER_ACTIVATION });
  }
  const resultStatus = typeof input.status === "string" ? input.status : plan.status;
  if (
    name === "plans.update" &&
    input.autoSync === true &&
    plan.autoSync !== true &&
    resultStatus === "active"
  ) {
    details.push({ kind: "warning", text: RUNNER_SYNC });
  }
  return {
    title: changeTitle(kind === "goal" ? "goal" : "plan", plan.title, name, input),
    details,
    destructive,
    guard,
  };
}
