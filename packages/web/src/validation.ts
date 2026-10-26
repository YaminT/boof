import { z } from "zod";
import {
  ClientKindSchema,
  GoalInputSchema,
  GoalStatusSchema,
  isKebabId,
  PlanStatusSchema,
  ProjectRolesOverrideSchema,
  ProjectReviewOverrideSchema,
  ProjectRetriesOverrideSchema,
  ProjectWorktreeOverrideSchema,
  ScopeSchema,
  StatusSchema,
  TrustSchema,
} from "@boof-runner/shared";
import { ServiceError } from "./service.js";

/** Route params that become filesystem path segments must be kebab-case ids. */
export function paramId(value: string | undefined, what = "id"): string {
  if (!isKebabId(value)) throw new ServiceError(400, `Invalid ${what}`, "invalid_input");
  return value;
}

/** Parse a JSON body against a schema; map failures to a 400 with readable details. */
export async function parseJson<T extends z.ZodType>(
  req: { json: () => Promise<unknown> },
  schema: T,
  code = "invalid_input",
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ServiceError(400, "Request body must be valid JSON", "invalid_input");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(400, "Invalid request body", code, formatIssues(parsed.error));
  }
  return parsed.data;
}

/** Like {@link parseJson} but an empty body counts as `{}` (POST actions whose options are all optional). */
export async function parseJsonOptional<T extends z.ZodType>(
  req: { text: () => Promise<string>; json: () => Promise<unknown> },
  schema: T,
  code = "invalid_input",
): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.trim() === "") return parseJson({ json: async () => ({}) }, schema, code);
  return parseJson({ json: async () => JSON.parse(text) }, schema, code);
}

export function formatIssues(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

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
export const InjectBody = z.object({ prompt: z.string().max(100_000) }).strict();
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
