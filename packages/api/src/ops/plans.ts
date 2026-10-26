import { z } from "zod";
import { mergeOrderOf, PlanSchema } from "@boof-runner/shared";
import { defineOp } from "../define-op.js";
import { OpError } from "../errors.js";
import {
  CreatePlanBody,
  GoalStatusBody,
  ImportPlanBody,
  ReorderGoalsBody,
  ReplaceGoalsBody,
  SyncPlanBody,
  UpdatePlanBody,
  UpsertGoalBody,
} from "../validation.js";
import {
  ImportResultSchema,
  PlanCreateResultSchema,
  PlanSummarySchema,
  PlanViewSchema,
  SyncResultSchema,
} from "../schemas.js";
import {
  DESTRUCTIVE,
  goalIdParam,
  IDEMPOTENT_WRITE,
  planEtag,
  planIdParam,
  projectIdParam,
  READ,
  requireProject,
  WRITE,
} from "./common.js";

const IF_MATCH = "expectedVersion" as const;
const byPlan = z.strictObject({ projectId: projectIdParam, planId: planIdParam });
const planBase = { projectId: projectIdParam, planId: planIdParam };
const base = { invalidInputCode: "invalid_plan" as const };
const planText = (p: { id: string; version: number; goals: unknown[] }) =>
  `Plan ${p.id} is at version ${p.version} with ${p.goals.length} goal(s)`;

export const plansList = defineOp({
  name: "plans.list",
  title: "List plans",
  description:
    "Lists a project's plans with goal counts, without the goals. Input: projectId. No side effects.",
  scope: "plans:read",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam }),
  output: z.object({ plans: z.array(PlanSummarySchema) }),
  rest: { method: "GET", path: "/projects/{projectId}/plans" },
  mcp: { expose: true, name: "boof_list_plans", annotations: READ },
  summary: (r) => `${r.plans.length} plan(s): ${r.plans.map((p) => p.id).join(", ")}`,
  handler: async (ctx, input) => ({
    plans: await (await requireProject(ctx, input.projectId)).plans.list(),
  }),
});

export const plansCreate = defineOp({
  name: "plans.create",
  title: "Create a plan",
  description:
    "Creates a plan with optional goals (a dependency graph). Inputs: projectId, title, optional id, description, status, autoSync, bumpTo, goals. Review-trust clients always get a draft plan; the result then has warnings (status_downgraded) and the HTTP header Boof-Warning. A human approves the plan (sets it active); its tasks are then created pending.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, ...CreatePlanBody.shape }),
  output: PlanCreateResultSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/plans",
    status: 201,
    idempotent: true,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_create_plan", annotations: WRITE },
  summary: planText,
  ...base,
  handler: async (ctx, { projectId, ...body }) =>
    (await requireProject(ctx, projectId)).plans.createPlan(body, ctx.principal),
});

export const plansGet = defineOp({
  name: "plans.get",
  title: "Get a plan",
  description:
    "Returns a plan with all goals, its version and mergeOrder (the final task branch of each goal in topological plan order). Inputs: projectId, planId. No side effects.",
  scope: "plans:read",
  projectScoped: true,
  input: byPlan,
  output: PlanViewSchema,
  rest: { method: "GET", path: "/projects/{projectId}/plans/{planId}", etag: planEtag },
  mcp: { expose: true, name: "boof_get_plan", annotations: READ },
  summary: planText,
  handler: async (ctx, input) => {
    const plan = await (await requireProject(ctx, input.projectId)).plans.get(input.planId);
    return { ...plan, mergeOrder: mergeOrderOf(plan) };
  },
});

export const plansUpdate = defineOp({
  name: "plans.update",
  title: "Update a plan",
  description:
    "Changes plan fields (title, description, status, autoSync, bumpTo). Inputs: projectId, planId, fields, expectedVersion (HTTP If-Match) to refuse a stale write. Bumps the plan version.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ ...planBase, ...UpdatePlanBody.shape }),
  output: PlanSchema,
  rest: {
    method: "PUT",
    path: "/projects/{projectId}/plans/{planId}",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_update_plan", annotations: IDEMPOTENT_WRITE },
  summary: planText,
  ...base,
  handler: async (ctx, { projectId, planId, expectedVersion, ...patch }) =>
    (await requireProject(ctx, projectId)).plans.updatePlan(
      planId,
      patch,
      expectedVersion,
      ctx.principal,
    ),
});

export const plansReplaceGoals = defineOp({
  name: "plans.replaceGoals",
  title: "Replace all goals of a plan",
  description:
    "Replaces the whole goal graph; goals not listed are removed. Inputs: projectId, planId, goals, expectedVersion (If-Match). Bumps the plan version; the graph is validated.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ ...planBase, ...ReplaceGoalsBody.shape }),
  output: PlanSchema,
  rest: {
    method: "PUT",
    path: "/projects/{projectId}/plans/{planId}/goals",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_replace_goals", annotations: IDEMPOTENT_WRITE },
  summary: planText,
  ...base,
  handler: async (ctx, { projectId, planId, goals, expectedVersion }) =>
    (await requireProject(ctx, projectId)).plans.replaceGoals(
      planId,
      goals,
      expectedVersion,
      ctx.principal,
    ),
});

export const plansUpsertGoal = defineOp({
  name: "plans.upsertGoal",
  title: "Add or change a goal",
  description:
    "Adds a goal or changes the one named in the path. Inputs: projectId, planId, goalId, goal fields, expectedVersion (If-Match). Bumps the goal revision when its spec changes.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ ...planBase, goalId: goalIdParam, ...UpsertGoalBody.shape }),
  output: PlanSchema,
  rest: {
    method: "PUT",
    path: "/projects/{projectId}/plans/{planId}/goals/{goalId}",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_upsert_goal", annotations: IDEMPOTENT_WRITE },
  summary: planText,
  ...base,
  handler: async (ctx, { projectId, planId, goalId, expectedVersion, id: bodyId, ...rest }) => {
    if (bodyId !== undefined && bodyId !== goalId) {
      throw new OpError(400, "The goal id in the body must match the URL", "invalid_plan");
    }
    return (await requireProject(ctx, projectId)).plans.upsertGoal(
      planId,
      { ...rest, id: goalId },
      expectedVersion,
      ctx.principal,
    );
  },
});

export const plansRemoveGoal = defineOp({
  name: "plans.removeGoal",
  title: "Remove a goal",
  description:
    "Removes a goal; refused while other goals depend on it unless cascade. Inputs: projectId, planId, goalId, cascade, stopRunning (needs tasks:control), expectedVersion. Archives the goal's open tasks.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({
    ...planBase,
    goalId: goalIdParam,
    cascade: z.boolean().optional(),
    stopRunning: z.boolean().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  }),
  output: PlanSchema,
  rest: {
    method: "DELETE",
    path: "/projects/{projectId}/plans/{planId}/goals/{goalId}",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_remove_goal", annotations: DESTRUCTIVE },
  summary: planText,
  ...base,
  handler: async (ctx, { projectId, planId, goalId, expectedVersion, cascade, stopRunning }) =>
    (await requireProject(ctx, projectId)).plans.removeGoal(
      planId,
      goalId,
      expectedVersion,
      { cascade: cascade === true, stopRunning: stopRunning === true },
      ctx.principal,
    ),
});

export const plansReorderGoals = defineOp({
  name: "plans.reorderGoals",
  title: "Reorder goals",
  description:
    "Sets the goal order, dependencies first. Inputs: projectId, planId, order (every goal id once), expectedVersion. Bumps the plan version.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ ...planBase, ...ReorderGoalsBody.shape }),
  output: PlanSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/plans/{planId}/reorder",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_reorder_goals", annotations: IDEMPOTENT_WRITE },
  summary: planText,
  ...base,
  handler: async (ctx, { projectId, planId, order, expectedVersion }) =>
    (await requireProject(ctx, projectId)).plans.reorderGoals(
      planId,
      order,
      expectedVersion,
      ctx.principal,
    ),
});

export const plansSetGoalStatus = defineOp({
  name: "plans.setGoalStatus",
  title: "Set a goal's status",
  description:
    "Sets a goal's status (plan, develop, review, done) and records it in the goal history. Inputs: projectId, planId, goalId, status, optional description, expectedVersion.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ ...planBase, goalId: goalIdParam, ...GoalStatusBody.shape }),
  output: PlanSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/plans/{planId}/goals/{goalId}/status",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_set_goal_status", annotations: IDEMPOTENT_WRITE },
  summary: planText,
  handler: async (ctx, { projectId, planId, goalId, status, description, expectedVersion }) =>
    (await requireProject(ctx, projectId)).plans.setGoalStatus(
      planId,
      goalId,
      status,
      description,
      expectedVersion,
      ctx.principal,
    ),
});

export const plansImport = defineOp({
  name: "plans.import",
  title: "Import plan files from the repository",
  description:
    "Reads goal.boof.xml and plan.boof.xml files from the project's repository into a plan. Inputs: projectId, optional planId, merge, title, status, expectedVersion. Creates or (with merge) updates a plan.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, ...ImportPlanBody.shape }),
  output: ImportResultSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/plans/import",
    ifMatch: IF_MATCH,
    etag: planEtag,
  },
  mcp: { expose: true, name: "boof_import_plan", annotations: WRITE },
  summary: (r) =>
    `Imported plan ${r.plan.id}: ${r.added.length} added, ${r.updated.length} updated`,
  handler: async (ctx, { projectId, expectedVersion, ...input }) =>
    (await requireProject(ctx, projectId)).plans.importFromRepo(
      input,
      expectedVersion,
      ctx.principal,
    ),
});

export const plansExport = defineOp({
  name: "plans.export",
  title: "Export a plan as boof-planner files",
  description:
    "Renders a plan as plan.boof.xml and goal.boof.xml files, as a map of file name to content. Inputs: projectId, planId. Nothing is written into the repository.",
  scope: "plans:read",
  projectScoped: true,
  input: byPlan,
  output: z.record(z.string(), z.string()),
  rest: { method: "GET", path: "/projects/{projectId}/plans/{planId}/export" },
  mcp: { expose: true, name: "boof_export_plan", annotations: READ },
  summary: (r) => `${Object.keys(r).length} file(s)`,
  handler: async (ctx, input) =>
    (await requireProject(ctx, input.projectId)).plans.exportToXml(input.planId),
});

export const plansSync = defineOp({
  name: "plans.sync",
  title: "Sync a plan to tasks",
  description:
    "Creates one task per unblocked goal of an active plan and updates tasks of changed goals. Inputs: projectId, planId, dryRun, stopRunning (needs tasks:control). Writes tasks and goal bookkeeping unless dryRun.",
  scope: "plans:write",
  projectScoped: true,
  input: z.strictObject({ ...planBase, ...SyncPlanBody.shape }),
  output: SyncResultSchema,
  rest: { method: "POST", path: "/projects/{projectId}/plans/{planId}/sync", etag: planEtag },
  mcp: { expose: true, name: "boof_sync_plan", annotations: WRITE },
  summary: (r) =>
    `${r.dryRun ? "Dry run: " : ""}${r.created.length} created, ${r.updated.length} updated, ${r.archived.length} archived`,
  handler: async (ctx, { projectId, planId, ...opts }) =>
    (await requireProject(ctx, projectId)).plans.syncTasks(planId, opts, ctx.principal),
});

export const PLAN_WAIT_MAX_SECONDS = 60;

export const plansWait = defineOp({
  name: "plans.wait",
  title: "Wait for a plan to change, finish or get stuck",
  description: `Long-polls a plan for up to ${PLAN_WAIT_MAX_SECONDS} seconds. Returns at once when every goal is done (complete) or the plan cannot go on without you (stuck: a goal's task failed or has questions, or no task can run). Otherwise returns when the plan version passes sinceVersion, or on timeout. Inputs: projectId, planId, optional sinceVersion, timeoutSeconds. A draft plan returns at once with stuck true, one reason {status: plan-not-active} and awaitingApproval true. Output: plan, version, complete, stuck, stuckReasons, awaitingApproval, changed, timedOut. No side effects; call it again after a timeout.`,
  scope: "plans:read",
  projectScoped: true,
  input: z.strictObject({
    ...planBase,
    sinceVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: "Return once the plan version is higher than this (default: now)." }),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(PLAN_WAIT_MAX_SECONDS)
      .optional()
      .meta({
        description: `Longest wait in seconds, default 30, max ${PLAN_WAIT_MAX_SECONDS}.`,
      }),
  }),
  output: z.object({
    plan: PlanSchema,
    version: z.number().int(),
    complete: z.boolean().meta({ description: "Every goal is done." }),
    stuck: z.boolean().meta({ description: "The plan cannot go on until someone acts." }),
    stuckReasons: z.array(
      z.object({
        goalId: z.string(),
        taskId: z.string().nullable(),
        status: z.string().meta({
          description:
            "Task status (failed, action, draft, pending), blocked, no-task or plan-not-active.",
        }),
      }),
    ),
    awaitingApproval: z.boolean().meta({
      description:
        "The plan is a draft: it returns at once with stuck true and one reason (plan-not-active, empty goalId) until a human approves it.",
    }),
    changed: z.boolean(),
    timedOut: z.boolean(),
  }),
  rest: { method: "GET", path: "/projects/{projectId}/plans/{planId}/wait", etag: planEtag },
  mcp: { expose: true, name: "boof_wait_plan", annotations: READ },
  summary: (r) =>
    r.complete
      ? `Plan ${r.plan.id} is complete`
      : r.stuck
        ? `Plan ${r.plan.id} is stuck: ${r.stuckReasons.map((s) => `${s.goalId}[${s.status}]`).join(", ")}`
        : r.timedOut
          ? `Plan ${r.plan.id} is still at version ${r.version} (timed out)`
          : `Plan ${r.plan.id} is at version ${r.version}`,
  ...base,
  handler: async (ctx, input) =>
    (await requireProject(ctx, input.projectId)).plans.waitFor(input.planId, {
      sinceVersion: input.sinceVersion,
      timeoutMs: (input.timeoutSeconds ?? 30) * 1000,
    }),
});

export const planOps = [
  plansList,
  plansCreate,
  plansGet,
  plansUpdate,
  plansReplaceGoals,
  plansUpsertGoal,
  plansRemoveGoal,
  plansReorderGoals,
  plansSetGoalStatus,
  plansImport,
  plansExport,
  plansSync,
  plansWait,
];
