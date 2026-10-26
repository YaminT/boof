import { z } from "zod";
import {
  ClientKindSchema,
  GoalInputSchema,
  GoalStatusSchema,
  PlanStatusSchema,
  ProjectRolesOverrideSchema,
  ProjectReviewOverrideSchema,
  ProjectBudgetOverrideSchema,
  ProjectRetriesOverrideSchema,
  ProjectWorktreeOverrideSchema,
  ScopeSchema,
  StatusSchema,
  TrustSchema,
} from "@boof-runner/shared";

const labels = z.array(z.string().max(100)).max(50);
const commandRef = z.string().nullable();

export const CreateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().max(500_000).optional(),
    priority: z.number().int().optional(),
    labels: labels.optional(),
    command: commandRef.optional(),
    status: z.enum(["draft", "pending"]).optional(),
    runs: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const UpdateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().max(500_000).optional(),
    priority: z.number().int().optional(),
    labels: labels.optional(),
    command: commandRef.optional(),
    skip: z.boolean().optional(),
    runs: z.number().int().min(1).max(100).optional(),
    status: StatusSchema.optional(),
  })
  .strict();

export const SkipBody = z.object({ skip: z.boolean() }).strict();
export const ReorderBody = z.object({ order: z.array(z.string()).max(10_000) }).strict();
export const InjectModeSchema = z.enum(["next-step", "now"]).meta({
  description:
    "`next-step` (default): the prompt is picked up before the next pipeline step. `now`: also interrupts the running step, which is resumed (or rerun) with the prompt.",
});
export const InjectBody = z
  .object({ prompt: z.string().max(100_000), mode: InjectModeSchema.default("next-step") })
  .strict();
export const AnswersBody = z.object({ answers: z.string().max(200_000) }).strict();
export const CommandBody = z
  .object({ name: z.string().trim().min(1).max(200), body: z.string().max(200_000).optional() })
  .strict();

export const CreateProjectBody = z
  .object({
    workingDirectory: z.string().trim().min(1).max(4096),
    id: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(200)
      .optional(),
    name: z.string().trim().min(1).max(200).optional(),
    defaultBase: z.string().min(1).max(200).optional(),
    labels: labels.optional(),
    roles: ProjectRolesOverrideSchema.optional(),
    review: ProjectReviewOverrideSchema.optional(),
    worktree: ProjectWorktreeOverrideSchema.optional(),
    retries: ProjectRetriesOverrideSchema.optional(),
    budget: ProjectBudgetOverrideSchema.optional(),
    planWriteBack: z.boolean().optional(),
  })
  .strict();

const kebabId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// --- Plans (a body-level `expectedVersion` is the alternative to the If-Match header) ---

const expectedVersion = z.number().int().min(1).optional();
const bumpTo = z.enum(["review", "done"]);

export const CreatePlanBody = z
  .object({
    id: kebabId.max(200).optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).optional(),
    status: PlanStatusSchema.optional(),
    autoSync: z.boolean().optional(),
    bumpTo: bumpTo.optional(),
    goals: z.array(GoalInputSchema).max(2000).optional(),
  })
  .strict();

export const UpdatePlanBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    status: PlanStatusSchema.optional(),
    autoSync: z.boolean().optional(),
    bumpTo: bumpTo.optional(),
    expectedVersion,
  })
  .strict();

export const ReplaceGoalsBody = z
  .object({ goals: z.array(GoalInputSchema).max(2000), expectedVersion })
  .strict();

/** A goal for PUT goals/:goalId; `id` may be left out (the path names it). */
export const UpsertGoalBody = z
  .object({
    ...GoalInputSchema.shape,
    id: kebabId.max(200).optional(),
    expectedVersion,
  })
  .strict();

export const ReorderGoalsBody = z
  .object({ order: z.array(z.string()).max(10_000), expectedVersion })
  .strict();

export const GoalStatusBody = z
  .object({
    status: GoalStatusSchema,
    description: z.string().max(2000).optional(),
    expectedVersion,
  })
  .strict();

export const ImportPlanBody = z
  .object({
    planId: kebabId.max(200).optional(),
    merge: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    status: PlanStatusSchema.optional(),
    autoSync: z.boolean().optional(),
    bumpTo: bumpTo.optional(),
    expectedVersion,
  })
  .strict();

export const SyncPlanBody = z
  .object({ dryRun: z.boolean().optional(), stopRunning: z.boolean().optional() })
  .strict();

/** Query flags of DELETE goals/:goalId (a DELETE has no body). */
export const RemoveGoalQuery = z.object({
  cascade: z.enum(["1", "true"]).optional(),
  stopRunning: z.enum(["1", "true"]).optional(),
  expectedVersion: z.coerce.number().int().min(1).optional(),
});
export const CreateClientBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: ClientKindSchema.optional(),
    scopes: z.array(ScopeSchema).min(1),
    projects: z.union([z.literal("*"), z.array(kebabId)]).optional(),
    trust: TrustSchema.optional(),
    /** Duration like "30d"; omitted = never expires. */
    expiresIn: z.string().max(20).optional(),
  })
  .strict();

// --- Webhooks ---

export const CreateWebhookBody = z
  .object({
    url: z.string().trim().min(1).max(2000),
    /** Event types or `prefix.*` patterns; default: every event. */
    events: z
      .array(z.string().regex(/^(\*|[a-z]+(\.[a-z]+|\.\*)?)$/))
      .min(1)
      .max(20)
      .optional(),
    projects: z.union([z.literal("*"), z.array(kebabId).max(200)]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
