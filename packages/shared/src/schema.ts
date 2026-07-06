import { z } from "zod";

/** Task statuses; each maps to a directory under tasks/. */
export const StatusSchema = z.enum([
  "draft",
  "pending",
  "running",
  "action",
  "done",
  "failed",
  "archived",
]);
export type Status = z.infer<typeof StatusSchema>;

/** Question lifecycle for a task (replaces #hasQuestions markers). */
export const QuestionStateSchema = z.enum(["none", "pending", "answered"]);
export type QuestionState = z.infer<typeof QuestionStateSchema>;

export const RoleSchema = z.enum(["planner", "developer", "reviewer"]);
export type Role = z.infer<typeof RoleSchema>;

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case ([a-z0-9-])");

/**
 * ISO-8601 timestamp. YAML parsers (js-yaml via gray-matter) eagerly coerce
 * date-looking scalars into JS Date objects, so accept Date too and normalize
 * to an ISO string.
 */
const isoDatetime = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().datetime(),
);

/** A tool+model assignment for a single role. */
export const RoleAssignmentSchema = z.object({
  tool: z.string().min(1),
  model: z.string().min(1),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/** Optional per-task override of the global role assignments. */
export const TaskToolsSchema = z
  .object({
    planner: RoleAssignmentSchema.optional(),
    developer: RoleAssignmentSchema.optional(),
    reviewer: RoleAssignmentSchema.optional(),
  })
  .strict();
export type TaskTools = z.infer<typeof TaskToolsSchema>;

/** A file attached to a task (image or PDF), stored under tasks/assets/<id>/. */
export const AttachmentSchema = z.object({
  /** Stored filename, unique within the task's asset directory. */
  name: z.string().min(1),
  /** MIME type, e.g. image/png or application/pdf. */
  type: z.string().min(1),
  /** Byte size, best-effort. */
  size: z.number().nonnegative().default(0),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Per-step token usage, best-effort (token-tracking spec). */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  known: z.boolean().default(false),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Canonical task frontmatter (task-file spec). */
export const TaskFrontmatterSchema = z.object({
  id: kebab,
  title: z.string().min(1),
  status: StatusSchema,
  priority: z.number().int(),
  skip: z.boolean(),
  labels: z.array(z.string()).default([]),
  command: kebab.nullable().default(null),
  // Images/PDFs attached to the prompt; files live under tasks/assets/<id>/.
  attachments: z.array(AttachmentSchema).default([]),
  questions: QuestionStateSchema.default("none"),
  // How many times to run the pipeline for this task (user input, default 1).
  runs: z.number().int().min(1).default(1),
  // How many runs have completed so far (current iteration = completedRuns + 1).
  completedRuns: z.number().int().min(0).default(0),
  tools: TaskToolsSchema.optional(),
  tokens: TokenUsageSchema.optional(),
  created: isoDatetime,
  updated: isoDatetime,
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

/** Command-template frontmatter (command-templates spec). */
export const CommandTemplateFrontmatterSchema = z.object({
  id: kebab,
  name: z.string().min(1),
});
export type CommandTemplateFrontmatter = z.infer<typeof CommandTemplateFrontmatterSchema>;

/** settings.json schema (settings spec). */
export const SettingsSchema = z.object({
  runner: z.object({ enabled: z.boolean() }),
  workingDirectory: z.string(),
  selectedSubdirectory: z.string().nullable().default(null),
  blockHours: z.array(z.unknown()).default([]),
  tokens: z.record(z.unknown()).default({}),
  roles: z.object({
    planner: RoleAssignmentSchema,
    developer: RoleAssignmentSchema,
    reviewer: RoleAssignmentSchema,
  }),
  models: z.record(z.array(z.string())),
});
export type Settings = z.infer<typeof SettingsSchema>;
