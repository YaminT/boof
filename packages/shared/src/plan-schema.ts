import { z } from "zod";
import {
  IsoDatetimeSchema as isoDatetime,
  KebabIdSchema as kebab,
  StatusSchema,
} from "./schema.js";

/** Canonical goal path: posix separators, no empty or `.` segments; the repository root is ".". */
export function normalizeGoalPath(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  return parts.length === 0 ? "." : parts.join("/");
}

/** A directory path relative to the repo root that cannot climb out of it. */
const relPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("\\") &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.includes("\0") &&
      !p.split(/[\\/]/).includes(".."),
    "path must be relative and stay inside the repository",
  )
  .overwrite(normalizeGoalPath);

/** Goal status; the same four values as goal.boof.xml (BOOF_STATUSES). */
export const GoalStatusSchema = z.enum(["plan", "develop", "review", "done"]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/** The spec of a goal; mirrors BoofGoal.overal + progress.tests, lossless to goal.boof.xml. */
export const GoalSpecSchema = z.object({
  goal: z.string().min(1),
  stack: z.string().min(1),
  rules: z.object({
    do: z.array(z.string().min(1)).min(1),
    dont: z.array(z.string().min(1)).default([]),
  }),
  tests: z.object({
    strategy: z.string().min(1),
    technology: z.string().min(1),
    run: z.string().min(1),
    coverage: z.string().min(1).optional(),
  }),
});
export type GoalSpec = z.infer<typeof GoalSpecSchema>;

/** One status entry of a goal (= a goal.boof.xml <version>). */
export const GoalHistoryEntrySchema = z.object({
  /** Goal (spec) revision in force when the entry was recorded. */
  revision: z.number().int().min(1),
  status: GoalStatusSchema,
  description: z.string(),
  at: isoDatetime,
  /** The <version number> of an entry imported from a goal file; keeps export lossless. */
  number: z.number().int().min(1).optional(),
  /** The task whose completion this entry records (runtime only; never exported to XML). */
  taskId: kebab.optional(),
});
export type GoalHistoryEntry = z.infer<typeof GoalHistoryEntrySchema>;

/** A task created for a goal (runtime only; never exported to XML). */
export const GoalTaskRefSchema = z.object({
  taskId: kebab,
  /** Goal revision the task was built for. */
  revision: z.number().int().min(1),
  /** Last known task status; the task file is the source of truth. */
  status: StatusSchema,
  /** The git branch of the task, `boof-runner/<taskId>`. */
  branch: z.string().min(1),
});
export type GoalTaskRef = z.infer<typeof GoalTaskRefSchema>;

/** The spec a task prompt was last built from; lets sync diff old against new. */
export const GoalSyncedSchema = z.object({
  revision: z.number().int().min(1),
  spec: GoalSpecSchema,
  dependsOn: z.array(kebab).default([]),
  model: z.string().optional(),
});
export type GoalSynced = z.infer<typeof GoalSyncedSchema>;

export const GoalSchema = z.object({
  id: kebab,
  title: z.string().min(1),
  /** Unit directory relative to the repo root (set on import; optional for API-born goals). */
  path: relPath.optional(),
  order: z.number().int().min(1),
  dependsOn: z.array(kebab).default([]),
  status: GoalStatusSchema.default("plan"),
  /** Goal-level model hint (BoofGoal.model). */
  model: z.string().min(1).optional(),
  spec: GoalSpecSchema,
  /** Bumped on every spec / dependsOn / model change. */
  revision: z.number().int().min(1).default(1),
  /** The live task materialised for this goal, if any. */
  taskId: kebab.nullable().default(null),
  /** Every task created for this goal, oldest first (runtime only; the last one holds the final state). */
  tasks: z.array(GoalTaskRefSchema).default([]),
  history: z.array(GoalHistoryEntrySchema).default([]),
  synced: GoalSyncedSchema.optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const PlanStatusSchema = z.enum(["draft", "active", "archived"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSourceSchema = z.object({
  kind: z.enum(["ui", "api", "mcp", "repo-import"]),
  /** Client id when an authenticated client created the plan. */
  client: z.string().optional(),
  importedFrom: z.string().optional(),
});
export type PlanSource = z.infer<typeof PlanSourceSchema>;

/** Who approved the content of an active plan, and when (a trusted or local principal set it `active`). */
export const PlanApprovalSchema = z.object({
  principalId: z.string().min(1),
  at: isoDatetime,
  /** The plan version the approval produced. */
  version: z.number().int().min(1),
});
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

export const PlanSchema = z.object({
  id: kebab,
  title: z.string().min(1),
  description: z.string().default(""),
  /** draft: not synced; active: syncable; archived: kept for history. */
  status: PlanStatusSchema.default("draft"),
  /** The engine syncs the plan before it picks a task. */
  autoSync: z.boolean().default(false),
  bumpTo: z.enum(["review", "done"]).default("done"),
  /** Set while the plan is active and a trusted or local principal approved it; cleared otherwise. */
  approvedBy: PlanApprovalSchema.optional(),
  source: PlanSourceSchema,
  goals: z.array(GoalSchema),
  /** Optimistic concurrency token, bumped on every write. */
  version: z.number().int().min(1).default(1),
  created: isoDatetime,
  updated: isoDatetime,
});
export type Plan = z.infer<typeof PlanSchema>;

/** A goal as sent by a client: server-owned fields (revision, taskId, history, synced) are left out. */
export const GoalInputSchema = z.object({
  id: kebab,
  title: z.string().min(1).max(500),
  path: relPath.optional(),
  /** Omitted: the goal keeps its stored order, or is appended when new. */
  order: z.number().int().min(1).optional(),
  dependsOn: z.array(kebab).default([]),
  /** Omitted: a stored goal keeps its status, a new one starts at `plan`. */
  status: GoalStatusSchema.optional(),
  model: z.string().min(1).optional(),
  spec: GoalSpecSchema,
});
export type GoalInput = z.input<typeof GoalInputSchema>;
export type GoalInputParsed = z.output<typeof GoalInputSchema>;
