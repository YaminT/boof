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
