/** Output (and shared) schemas of the operations. */
import { z } from "zod";
import {
  ClientSchema,
  PlanSchema,
  ProjectSchema,
  SettingsSchema,
  TaskFrontmatterSchema,
  TokenUsageSchema,
  WebhookSchema,
} from "@boof-runner/shared";
import { WarningSchema } from "./warnings.js";

export const TaskViewSchema = z.object({
  frontmatter: TaskFrontmatterSchema,
  body: z.object({
    prompt: z.string(),
    command: z.string(),
    questions: z.string(),
    answers: z.string(),
    reports: z.object({
      planner: z.string(),
      developer: z.string(),
      observer: z.string(),
      reviewer: z.string(),
    }),
    /** Only with `include=log` (tasks.get) and on the unversioned routes. */
    log: z.string().optional(),
  }),
  projectId: z.string(),
  /** Observer and reviewer rounds parsed from the reports, oldest first. */
  reviews: z.array(
    z.object({
      role: z.enum(["observer", "reviewer"]),
      round: z.number().int(),
      iteration: z.number().int(),
      verdict: z.enum(["APPROVE", "CHANGES_REQUESTED", "REJECT", "INVALID"]),
      summary: z.string().meta({ description: "First non-empty, non-heading line of the report." }),
    }),
  ),
  /** The verdict of the last round of each role that reviewed. */
  finalVerdict: z.object({
    observer: z.enum(["APPROVE", "CHANGES_REQUESTED", "REJECT", "INVALID"]).optional(),
    reviewer: z.enum(["APPROVE", "CHANGES_REQUESTED", "REJECT", "INVALID"]).optional(),
  }),
  /** `boof-runner/<id>` when the task ran in a git worktree. */
  branch: z.string().optional(),
  /** The commit the task's worktree started from, when the task log recorded it. */
  baseSha: z.string().optional(),
});

/** The result of a create: the task plus the warnings when the server changed the requested status. */
export const TaskCreateResultSchema = TaskViewSchema.extend({
  warnings: z.array(WarningSchema).optional(),
});

/** The result of a plan create: the plan plus the warnings when the server changed the requested status. */
export const PlanCreateResultSchema = PlanSchema.extend({
  warnings: z.array(WarningSchema).optional(),
});

export const OkSchema = z.object({ ok: z.literal(true) });

export const PlanSummarySchema = PlanSchema.omit({ goals: true }).extend({
  goalCount: z.number().int(),
  doneCount: z.number().int(),
});

export const SyncResultSchema = z.object({
  planId: z.string(),
  dryRun: z.boolean(),
  created: z.array(
    z.object({
      goalId: z.string(),
      taskId: z.string(),
      revision: z.number().int(),
      followUp: z.boolean(),
      status: z.string(),
      skip: z.boolean(),
    }),
  ),
  updated: z.array(
    z.object({
      goalId: z.string(),
      taskId: z.string(),
      action: z.enum(["rewritten", "appended", "injected", "unskipped", "blocked"]),
      revision: z.number().int(),
    }),
  ),
  skipped: z.array(
    z.object({ goalId: z.string(), taskId: z.string().optional(), reason: z.literal("blocked") }),
  ),
  archived: z.array(
    z.object({
      goalId: z.string(),
      taskId: z.string(),
      action: z.enum(["archived", "stop-requested"]),
      reason: z.literal("goal-removed"),
    }),
  ),
  plan: PlanSchema,
});

export const ImportResultSchema = z.object({
  plan: PlanSchema,
  added: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.array(z.string()),
  warnings: z.array(z.string()),
});

/** Settings as the API shows them: webhooks are managed (and hidden) through their own operations. */
export const PublicSettingsSchema = SettingsSchema.omit({ webhooks: true });

export const PublicClientSchema = ClientSchema.omit({ keyHash: true });

export const PublicWebhookSchema = WebhookSchema.omit({ secret: true });

export const HealthResultSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  message: z.string(),
  version: z.string().optional(),
});

export const CommandTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
});

export { PlanSchema, ProjectSchema, TokenUsageSchema };
