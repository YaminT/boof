import { z } from "zod";

/** Task statuses; each maps to a directory under tasks/. */
export const StatusSchema = z.enum([
  "draft",
  "pending",
  "running",
  "action",
  "done",
  "failed",
  "stopped",
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
  z.iso.datetime(),
);

export const KebabIdSchema = kebab;
export const IsoDatetimeSchema = isoDatetime;

/** A tool+model assignment for a single role. */
export const RoleAssignmentSchema = z.object({
  tool: z.string().min(1),
  model: z.string().min(1),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/** Optional per-task override of the global role assignments. */
export const TaskToolsSchema = z.strictObject({
  planner: RoleAssignmentSchema.optional(),
  developer: RoleAssignmentSchema.optional(),
  observer: RoleAssignmentSchema.optional(),
  reviewer: RoleAssignmentSchema.optional(),
});
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

/**
 * Link from a plan-materialised task to the plan goal it implements (plan model). `revision` is
 * the goal revision the task's prompt was built from; sync compares it to the goal's current one.
 */
export const PlanRefSchema = z.object({
  planId: kebab,
  goalId: kebab,
  revision: z.number().int().min(1),
});
export type PlanRef = z.infer<typeof PlanRefSchema>;

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
  // When the task last entered `running`; kept after it leaves so finished tasks show it.
  startedAt: isoDatetime.optional(),
  // The current run's step headers in order; reset to [] on entering `running`.
  steps: z.array(z.object({ label: z.string().min(1), at: isoDatetime })).optional(),
  // Branch name or commit the task's worktree is created from (default: HEAD).
  base: z.string().min(1).optional(),
  // Set on scan-created tasks: on successful completion the runner appends a
  // <version> to this unit's goal.boof.xml, bumping its status (goal-ingestion).
  boofGoal: BoofGoalRefSchema.optional(),
  // Set on tasks materialised from a plan goal; the engine records the goal's status on done.
  planRef: PlanRefSchema.optional(),
  // "plan": the prompt was generated from the goal and sync may rewrite it; "manual": a human
  // edited it, so sync appends the spec diff instead (plan model, risks).
  promptSource: z.enum(["plan", "manual"]).optional(),
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

function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const usdLimit = z.number().positive().finite();
const ianaTimezone = z.string().refine(isIanaZone, { message: "not an IANA time zone" });

/**
 * Spending limits in USD; every limit is optional and absent means unlimited. Day limits reset at
 * local midnight in `timezone`. `onExceed` decides what happens to a task that crosses a limit:
 * `pause` keeps its worktree whatever `worktree.onFailure` says (so a retry resumes the work),
 * `fail` follows `worktree.onFailure`. Either way the task fails with a `budget exceeded` reason.
 */
export const BudgetSettingsSchema = z.object({
  /** Cost of one pipeline run of one task. */
  perTaskUsd: usdLimit.optional(),
  /** Cost of all work in one day. */
  perDayUsd: usdLimit.optional(),
  /** Cost of one project's work in one day (a project override replaces this). */
  perProjectDayUsd: usdLimit.optional(),
  /** Cost per tool id (claude-code, codex, ...) in one day, across projects. */
  perToolDayUsd: z.record(z.string().min(1), usdLimit).optional(),
  onExceed: z.enum(["pause", "fail"]).default("pause"),
  /** IANA zone that defines "a day"; the server's local zone when unset. */
  timezone: ianaTimezone.optional(),
});
export type BudgetSettings = z.infer<typeof BudgetSettingsSchema>;

/** Per-project budget override: no global scopes, no defaults, so unset keys inherit. */
export const ProjectBudgetOverrideSchema = z.strictObject({
  perTaskUsd: usdLimit.optional(),
  perProjectDayUsd: usdLimit.optional(),
  /** Day limit per tool for this project's own spend (the global limits still apply). */
  perToolDayUsd: z.record(z.string().min(1), usdLimit).optional(),
  onExceed: z.enum(["pause", "fail"]).optional(),
});
export type ProjectBudgetOverride = z.infer<typeof ProjectBudgetOverrideSchema>;

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
  /** Peers (IP literals, or "loopback") whose X-Forwarded-For / Forwarded headers name the real client; nginx on the same host: ["loopback"]. */
  trustedProxies: z.array(z.string()).default(["loopback"]),
  auth: z.object({ mode: z.enum(["local-trust", "required"]).default("local-trust") }).prefault({}),
  /** Roots under which non-local principals may register projects (e.g. ["~/codes"]). */
  allowedProjectRoots: z.array(z.string()).default([]),
  /** Webhook hosts (names or IP literals as written in the URL) allowed to resolve to loopback, link-local or private addresses; `"*"` disables the check. */
  allowedPrivateWebhookHosts: z.array(z.string()).default([]),
  /** review-trust clients land in draft and cannot queue work. */
  externalTasksRequireApproval: z.boolean().default(true),
  rateLimit: z
    .object({
      perMinute: z.number().int().min(1).default(600),
      attachmentsPerMinute: z.number().int().min(1).default(30),
      /** Failed authentications per client address per minute, charged before any key is checked. */
      unauthenticatedPerMinute: z.number().int().min(1).default(30),
    })
    .prefault({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      retentionDays: z.number().int().min(1).default(90),
    })
    .prefault({}),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/** MCP server settings; `enabled: false` turns the HTTP endpoint (and the stdio command) off. */
export const McpSettingsSchema = z.object({
  enabled: z.boolean().default(true),
});
export type McpSettings = z.infer<typeof McpSettingsSchema>;

/**
 * A webhook subscription (settings.webhooks). `events` holds event types or `prefix.*` patterns
 * (`task.status`, `plan.*`, `*`). The signing secret is not part of it: see WebhookSecretStore.
 */
export const WebhookSchema = z.object({
  id: kebab,
  url: z.string().min(1),
  events: z.array(z.string().min(1)).min(1),
  projects: z.union([z.literal("*"), z.array(kebab)]).default("*"),
  enabled: z.boolean().default(true),
  createdBy: z.string(),
  created: z.string(),
});
export type Webhook = z.infer<typeof WebhookSchema>;
/** A webhook as listed over the API (it carries no secret). */
export type PublicWebhook = Webhook;

const RolesSchema = z.object({
  planner: RoleAssignmentSchema,
  developer: RoleAssignmentSchema,
  observer: RoleAssignmentSchema.optional(),
  reviewer: RoleAssignmentSchema,
});

/** Runner section of settings.json. */
export const RunnerSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Tasks the engine may run at once; at most one per project (multi-project spec). */
  concurrency: z.number().int().min(1).default(1),
});
export type RunnerSettings = z.infer<typeof RunnerSettingsSchema>;

/** The `schemaVersion` written by this release. Absent in settings.json means v1. */
export const SETTINGS_SCHEMA_VERSION = 2 as const;

/** settings.json schema, v2 (global settings; per-project directories live in projects/). */
export const SettingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  runner: RunnerSettingsSchema,
  /** Project the legacy /api/tasks routes and the UI start on; null when unset. */
  defaultProject: kebab.nullable().default(null),
  roles: RolesSchema,
  review: ReviewSettingsSchema.optional(),
  worktree: WorktreeSettingsSchema.optional(),
  retries: RetrySettingsSchema.optional(),
  budget: BudgetSettingsSchema.optional(),
  security: SecuritySettingsSchema.optional(),
  mcp: McpSettingsSchema.optional(),
  /** Webhook subscriptions; managed through the webhooks operations (admin), never PUT /settings. */
  webhooks: z.array(WebhookSchema).optional(),
  models: z.record(z.string(), z.array(z.string())),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * settings.json as written by v1 (no `schemaVersion`). Used only by the v1 -> v2
 * migration; unknown keys (blockHours, tokens, selectedSubdirectory, ...) are dropped.
 */
export const LegacySettingsSchema = z.object({
  runner: z.object({ enabled: z.boolean() }),
  workingDirectory: z.string().default(""),
  roles: RolesSchema,
  review: ReviewSettingsSchema.optional(),
  worktree: WorktreeSettingsSchema.optional(),
  retries: RetrySettingsSchema.optional(),
  security: SecuritySettingsSchema.optional(),
  models: z.record(z.string(), z.array(z.string())),
});
export type LegacySettings = z.infer<typeof LegacySettingsSchema>;

/**
 * Fields a client may change through PUT /api/settings. Unknown keys are
 * rejected (the working directory is per project now). Nested objects are
 * replaced as a whole, except `runner`, which merges per key.
 */
export const SettingsPatchSchema = z
  .strictObject({
    runner: z
      .strictObject({
        enabled: z.boolean().optional(),
        concurrency: z.number().int().min(1).optional(),
      })
      .optional(),
    defaultProject: kebab.nullable().optional(),
    roles: RolesSchema.optional(),
    review: ReviewSettingsSchema.optional(),
    worktree: WorktreeSettingsSchema.optional(),
    retries: RetrySettingsSchema.optional(),
    budget: BudgetSettingsSchema.optional(),
    models: z.record(z.string(), z.array(z.string())).optional(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// --- Projects (multi-project spec) ---

/** Per-project overrides: every key optional and WITHOUT defaults, so unset keys inherit. */
export const ProjectRolesOverrideSchema = z.strictObject({
  planner: RoleAssignmentSchema.optional(),
  developer: RoleAssignmentSchema.optional(),
  observer: RoleAssignmentSchema.optional(),
  reviewer: RoleAssignmentSchema.optional(),
});
export const ProjectReviewOverrideSchema = z.strictObject({
  gate: z.boolean().optional(),
  maxFixRounds: z.number().int().min(0).optional(),
  maxInlineDiffBytes: z.number().int().positive().optional(),
});
export const ProjectWorktreeOverrideSchema = z.strictObject({
  root: z.string().min(1).optional(),
  onDone: z.enum(["keep-branch", "keep", "delete"]).optional(),
  onFailure: z.enum(["keep", "delete"]).optional(),
});
export const ProjectRetriesOverrideSchema = z.strictObject({
  transient: z.number().int().min(0).optional(),
  backoffMs: z.array(z.number().int().min(0)).optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
});

export const ProjectOriginSchema = z.object({
  kind: z.enum(["ui", "cli", "api", "migration"]),
  client: z.string().optional(),
});
export type ProjectOrigin = z.infer<typeof ProjectOriginSchema>;

/** projects/<id>/project.json. */
export const ProjectSchema = z.object({
  /** Directory name under projects/. */
  id: kebab,
  name: z.string().min(1),
  /**
   * Absolute, realpath-resolved at create time. Empty only for a project migrated from a v1
   * data root that never had a working directory; the runner skips such projects.
   */
  workingDirectory: z.string(),
  /** The runner skips a paused project. */
  paused: z.boolean().default(false),
  archived: z.boolean().default(false),
  /** Default task `base` ref. */
  defaultBase: z.string().min(1).optional(),
  roles: ProjectRolesOverrideSchema.optional(),
  review: ProjectReviewOverrideSchema.optional(),
  worktree: ProjectWorktreeOverrideSchema.optional(),
  retries: ProjectRetriesOverrideSchema.optional(),
  budget: ProjectBudgetOverrideSchema.optional(),
  /** Plan 03: write goal status back into the repo XML. */
  planWriteBack: z.boolean().default(true),
  labels: z.array(z.string()).default([]),
  origin: ProjectOriginSchema,
  created: isoDatetime,
  updated: isoDatetime,
});
export type Project = z.infer<typeof ProjectSchema>;

/** Fields PUT /api/projects/:pid may change. `null` clears an optional field. */
export const ProjectPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    workingDirectory: z.string().min(1),
    paused: z.boolean(),
    archived: z.boolean(),
    defaultBase: z.string().min(1).nullable(),
    roles: ProjectRolesOverrideSchema.nullable(),
    review: ProjectReviewOverrideSchema.nullable(),
    worktree: ProjectWorktreeOverrideSchema.nullable(),
    retries: ProjectRetriesOverrideSchema.nullable(),
    budget: ProjectBudgetOverrideSchema.nullable(),
    planWriteBack: z.boolean(),
    labels: z.array(z.string().max(100)).max(50),
  })
  .partial();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
