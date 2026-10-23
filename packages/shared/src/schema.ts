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

export const RoleSchema = z.enum(["planner", "developer", "observer", "reviewer"]);
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
    observer: RoleAssignmentSchema.optional(),
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

/**
 * Link from a scan-created task back to the goal.boof.xml it implements. On
 * success the runner appends a version with status `bumpTo` (goal-ingestion).
 * `path` is relative to the runner's workingDirectory (the scanned repo).
 */
export const BoofGoalRefSchema = z.object({
  path: z.string().min(1),
  bumpTo: z.enum(["review", "done"]).default("done"),
});
export type BoofGoalRef = z.infer<typeof BoofGoalRefSchema>;

/** Where a task came from; set when an authenticated client created it (api-security). */
export const TaskOriginSchema = z.object({
  kind: z.enum(["ui", "cli", "api", "mcp"]),
  client: kebab.optional(),
});
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;

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
  // Branch name or commit the task's worktree is created from (default: HEAD).
  base: z.string().min(1).optional(),
  // Set on scan-created tasks: on successful completion the runner appends a
  // <version> to this unit's goal.boof.xml, bumping its status (goal-ingestion).
  boofGoal: BoofGoalRefSchema.optional(),
  // Set when the task was submitted by an external client (drives the prompt's Provenance section).
  origin: TaskOriginSchema.optional(),
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

/** Review gate / fix-loop settings; every key optional with a default. */
export const ReviewSettingsSchema = z.object({
  /** Enforce observer/reviewer verdicts: only a reviewer APPROVE finishes as done. */
  gate: z.boolean().default(true),
  /** Max developer fix rounds per reviewing role (observer, reviewer). */
  maxFixRounds: z.number().int().min(0).default(2),
  /** Largest diff (bytes) inlined into a prompt; larger gets --stat + a note. */
  maxInlineDiffBytes: z.number().int().positive().default(120000),
});
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

/** Worktree location and retention; every key optional with a default. */
export const WorktreeSettingsSchema = z.object({
  /** Directory holding task worktrees; default <workingDirectory>/.boof-runner-worktrees. */
  root: z.string().min(1).optional(),
  /** What happens to a done task's branch and directory. */
  onDone: z.enum(["keep-branch", "keep", "delete"]).default("keep-branch"),
  /** What happens to a failed task's branch and directory (never applies to stops). */
  onFailure: z.enum(["keep", "delete"]).default("keep"),
});
export type WorktreeSettings = z.infer<typeof WorktreeSettingsSchema>;

/** Transient-error retry and stall detection; every key optional with a default. */
export const RetrySettingsSchema = z.object({
  /** Retries per tool step after a transient failure. */
  transient: z.number().int().min(0).default(2),
  /** Delay before each retry; the last entry repeats. */
  backoffMs: z.array(z.number().int().min(0)).default([30000, 120000]),
  /** Kill a tool step that prints nothing for this long and treat it as transient. */
  idleTimeoutMs: z.number().int().positive().default(1200000),
});
export type RetrySettings = z.infer<typeof RetrySettingsSchema>;

/** Authorization scopes (api-security). `admin` implies every other scope. */
export const SCOPES = [
  "projects:read",
  "projects:write",
  "plans:read",
  "plans:write",
  "tasks:read",
  "tasks:write",
  "tasks:control",
  "settings:read",
  "settings:write",
  "runner:control",
  "auth:admin",
  "admin",
] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const TrustSchema = z.enum(["trusted", "review"]);
export type Trust = z.infer<typeof TrustSchema>;

export const ClientKindSchema = z.enum(["harness", "mcp", "ui", "cli"]);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/** An API client stored in <data>/auth/clients.json. The secret is never stored, only its hash. */
export const ClientSchema = z.object({
  id: kebab,
  name: z.string().min(1).max(200),
  kind: ClientKindSchema,
  /** sha256(secret), hex. */
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(ScopeSchema),
  projects: z.union([z.literal("*"), z.array(kebab)]).default("*"),
  trust: TrustSchema.default("review"),
  created: z.string(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
});
export type Client = z.infer<typeof ClientSchema>;

/** A client as exposed over the API / CLI: never includes the key hash. */
export type PublicClient = Omit<Client, "keyHash">;

/** Security settings (api-security section 2); every key optional with a default. */
export const SecuritySettingsSchema = z.object({
  /** Extra Host header values accepted besides loopback. */
  allowedHosts: z.array(z.string()).default([]),
  auth: z.object({ mode: z.enum(["local-trust", "required"]).default("local-trust") }).default({}),
  /** Roots under which non-local principals may register projects (e.g. ["~/codes"]). */
  allowedProjectRoots: z.array(z.string()).default([]),
  /** review-trust clients land in draft and cannot queue work. */
  externalTasksRequireApproval: z.boolean().default(true),
  rateLimit: z
    .object({
      perMinute: z.number().int().min(1).default(600),
      attachmentsPerMinute: z.number().int().min(1).default(30),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      retentionDays: z.number().int().min(1).default(90),
    })
    .default({}),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/** settings.json schema (settings spec). */
export const SettingsSchema = z.object({
  runner: z.object({ enabled: z.boolean() }),
  workingDirectory: z.string(),
  roles: z.object({
    planner: RoleAssignmentSchema,
    developer: RoleAssignmentSchema,
    observer: RoleAssignmentSchema.optional(),
    reviewer: RoleAssignmentSchema,
  }),
  review: ReviewSettingsSchema.optional(),
  worktree: WorktreeSettingsSchema.optional(),
  retries: RetrySettingsSchema.optional(),
  security: SecuritySettingsSchema.optional(),
  models: z.record(z.array(z.string())),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Fields a client may change through PUT /api/settings. Unknown keys are
 * rejected. Nested objects are replaced as a whole, matching SettingsStore.update.
 */
export const SettingsPatchSchema = SettingsSchema.pick({
  runner: true,
  workingDirectory: true,
  roles: true,
  review: true,
  worktree: true,
  retries: true,
  models: true,
})
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
