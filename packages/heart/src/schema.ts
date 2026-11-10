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
export const RoleAssignmentSchema = z
  .object({
    tool: z.string().min(1),
    model: z
      .string()
      .refine((model) => model.trim().length > 0 || model.length === 0, {
        message: "Model must not contain only whitespace",
      })
      .meta({
        description:
          "Model identifier. For codex, an empty string uses the Codex CLI built-in default; config.toml model is ignored unless runner.inheritMcpServers is enabled. Required (non-empty) for every other tool.",
      }),
  })
  .refine((assignment) => assignment.tool === "codex" || assignment.model.length > 0, {
    message: "Model is required for tools other than codex",
    path: ["model"],
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

// ---- n8n (optional external pipeline steps) ----

/** Where an external step runs in the pipeline. */
export const EXTERNAL_STEP_POINTS = ["after-planner", "after-developer", "after-review"] as const;
export type ExternalStepPoint = (typeof EXTERNAL_STEP_POINTS)[number];
export const N8N_DEFAULT_TIMEOUT_MS = 1_800_000;
/** No `.` or `..` segment, no `//`, no `?` or `#`, no leading `/`, 1-200 chars of [A-Za-z0-9._~:/-]. */
export const WEBHOOK_PATH_PATTERN =
  /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!(?:.*\/)?\.(?:\/|$))[A-Za-z0-9._~:/-]{1,200}$/;

/** The canonical form of an n8n URL, or null when the input is not exactly that form. */
function canonicalN8nUrl(v: string): string | null {
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
    if (v.includes("?") || v.includes("#") || v.includes("@") || u.port === "0") return null;
    const canonical = u.href.replace(/\/+$/, "");
    // Refuse anything the URL parser rewrites (backslashes, %2e%2e, whitespace, default ports...):
    // what an admin reads must be what boof calls.
    if (v.replace(/\/+$/, "") !== canonical) return null;
    return canonical;
  } catch {
    return null;
  }
}

/** An http(s) URL in canonical form, without credentials, query or hash; a path (a proxy prefix) is allowed. */
const n8nUrl = z
  .string()
  .max(2000)
  .refine((v) => canonicalN8nUrl(v) !== null, {
    message: "must be a canonical http(s) URL without credentials, query or hash",
  })
  .transform((v) => canonicalN8nUrl(v) as string);

const n8nTimeoutMs = z.number().int().min(10_000).max(86_400_000);

export const N8nSettingsSchema = z.strictObject({
  /** The n8n instance (editor and API); a path is allowed when n8n sits behind a prefix. */
  baseUrl: n8nUrl,
  /** Where webhooks live; default `${baseUrl}/webhook`. */
  webhookBaseUrl: n8nUrl.optional(),
  /** The URL n8n uses to reach boof, proxy prefix included. */
  callbackBaseUrl: n8nUrl,
  defaultTimeoutMs: n8nTimeoutMs.default(N8N_DEFAULT_TIMEOUT_MS),
  /** Opt-in: a check task after a workflow edit. */
  checks: z
    .strictObject({
      enabled: z.boolean().default(false),
      projectId: kebab,
      autoQueue: z.boolean().default(false),
      pollIntervalMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
    })
    .optional(),
});
export type N8nSettings = z.infer<typeof N8nSettingsSchema>;

/** One external (n8n) step of a project's pipeline. */
export const ExternalStepSchema = z.strictObject({
  id: kebab,
  label: z.string().trim().min(1).max(80),
  at: z.enum(EXTERNAL_STEP_POINTS),
  workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  webhookPath: z.string().regex(WEBHOOK_PATH_PATTERN, "invalid webhook path"),
  timeoutMs: n8nTimeoutMs.optional(),
  onFailure: z.enum(["fail", "continue"]).default("fail"),
  sendDiff: z.boolean().default(false),
});
export type ExternalStep = z.infer<typeof ExternalStepSchema>;

const ExternalStepsSchema = z
  .array(ExternalStepSchema)
  .max(10)
  .superRefine((steps, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of steps.entries()) {
      if (seen.has(s.id))
        ctx.addIssue({
          code: "custom",
          message: `duplicate external step id: ${s.id}`,
          path: [i, "id"],
        });
      seen.add(s.id);
    }
  });

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
  // The agent process of an interrupted run that was still alive when the runner recovered the task.
  // The working-area pid record goes with the move to failed; this survives it, so Retry can refuse
  // while that process runs. Cleared when the task is queued again.
  agentProcess: z
    .object({
      pgid: z.number().int().positive(),
      command: z.string(),
      bootId: z.string().nullable(),
      startTicks: z.number().int().nullable(),
      startTime: z.string().nullable(),
      recordedAt: isoDatetime,
    })
    .optional(),
  // The task's epic (a record in the project's epics.json). A subtask has none of its own: its epic
  // is its parent's. Both keys resolve only inside the task's project; a missing target is dangling.
  epicId: kebab.optional(),
  // The parent task (one level only). Written only by hierarchy.ts, through TaskStore.modify.
  parentId: kebab.optional(),
  // Set on a check task created after an n8n workflow edit.
  n8nCheck: z
    .object({
      workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      workflowName: z.string().min(1).max(200),
      webhookPath: z.string().regex(WEBHOOK_PATH_PATTERN),
      updatedAt: isoDatetime,
    })
    .optional(),
  created: isoDatetime,
  updated: isoDatetime,
});
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

/** A group of tasks in one project, stored in `projects/<id>/epics.json`. */
export const EpicSchema = z.object({
  id: kebab,
  // Who created it (set by the server; absent for a human's or an older epic). Not a patch field.
  origin: TaskOriginSchema.optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  priority: z.number().int().default(0),
  archived: z.boolean().default(false),
  created: isoDatetime,
  updated: isoDatetime,
});
export type Epic = z.infer<typeof EpicSchema>;

export const EpicsFileSchema = z.object({ epics: z.array(EpicSchema).default([]) });

/** Fields of an epic a caller may change; `null` clears the description. */
export const EpicPatchSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).nullable(),
    priority: z.number().int(),
    archived: z.boolean(),
  })
  .partial();
export type EpicPatch = z.infer<typeof EpicPatchSchema>;

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
  /** How long a running task waits in place for the account pool to recover (owlish). Default 30 minutes. */
  poolWaitMs: z.number().int().positive().default(1_800_000),
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
  /** Roots under which non-local principals may register projects (e.g. ["~/codes"]). Absolute paths or `~/...`; a relative entry matches nothing. */
  allowedProjectRoots: z.array(z.string()).default([]),
  /** Webhook hosts (names or IP literals as written in the URL) allowed to resolve to loopback, link-local or private addresses; `"*"` disables the check. */
  allowedPrivateWebhookHosts: z.array(z.string()).default([]),
  /** review-trust clients land in draft and cannot queue work. */
  externalTasksRequireApproval: z.boolean().default(true),
  rateLimit: z
    .object({
      perMinute: z.number().int().min(1).default(600),
      attachmentsPerMinute: z.number().int().min(1).default(30),
      /** Failed authentications per client address per minute; a request whose key verifies is never limited. */
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
 * Console assistant (concierge). Absent on `Settings`: `conciergeSettings` applies these defaults.
 * `model: "default"` lets the Agent SDK choose. Spend is capped per message and per conversation.
 */
export const ConciergeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  model: z
    .string()
    .regex(/^[A-Za-z0-9._:\[\]\/-]{1,100}$/)
    .default("default"),
  perMessageUsd: z.number().positive().max(50).default(0.25),
  perConversationUsd: z.number().positive().max(500).default(2),
  messagesPerMinute: z.int().min(1).max(60).default(6),
  maxTurns: z.int().min(1).max(20).default(8),
  timeoutMs: z.int().min(10_000).max(600_000).default(120_000),
  idleMinutes: z.int().min(5).max(240).default(30),
});
export type ConciergeSettings = z.infer<typeof ConciergeSettingsSchema>;

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
  /** True when an API client created it: delivery then needs that client to be live and to cover `projects`. */
  createdByClient: z.boolean().optional(),
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

/** An environment variable name. */
const EnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
  .max(200);

/**
 * The optional account pool (better-ccflare). Absent: boof works as before. The client key is not
 * here; it lives in `<data>/owlish/secrets.json` or `BOOF_OWLISH_API_KEY`.
 */
export const OwlishSettingsSchema = z.strictObject({
  url: z
    .string()
    .url()
    .regex(/^https?:\/\//i, "must be an http(s) URL")
    .max(500)
    .refine(
      isValidOwlishGatewayUrl,
      "Use HTTPS off loopback, an ASCII DNS hostname or bracketed IPv6 literal, and omit credentials, query and fragment",
    ),
  /** `pause`: no routed task starts while the pool is unhealthy; `warn`: report only; `off`: ignore. */
  healthGate: z.enum(["pause", "warn", "off"]).default("pause"),
});

/** Shared URL parser and policy for settings validation and runtime routing. */
export function parseOwlishGatewayUrl(value: string): URL | null {
  if (/[\u0000-\u0020\u007f]/.test(value) || value.endsWith("?") || value.endsWith("#"))
    return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // WHATWG URL keeps TOML punctuation such as quotes and braces in an https host. Restrict
  // ordinary DNS/IPv4 names to ASCII labels (including IDNA's ASCII punycode form), and allow
  // IPv6 only in its URL-required bracketed form.
  const rawHostname = parsed.hostname;
  const validHostname = rawHostname.startsWith("[")
    ? /^\[[0-9a-f:.]+\]$/i.test(rawHostname)
    : rawHostname
        .replace(/\.$/, "")
        .split(".")
        .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  if (!validHostname) return null;
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const loopback =
    hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol === "http:" && !loopback)
  )
    return null;
  return parsed;
}

export function isValidOwlishGatewayUrl(value: string): boolean {
  return parseOwlishGatewayUrl(value) !== null;
}
export type OwlishSettings = z.infer<typeof OwlishSettingsSchema>;

/** Runner section of settings.json. */
export const RunnerSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Tasks the engine may run at once; at most one per project (multi-project spec). */
  concurrency: z.number().int().min(1).default(1),
  /**
   * Let task agents load the MCP servers of the user's own config (claude: `~/.claude.json`,
   * project `.mcp.json`). Off by default: an agent run unattended with every permission prompt
   * skipped must not get the user's other tools (mail, browser, cloud accounts).
   */
  inheritMcpServers: z.boolean().default(false),
  /**
   * Extra environment variable names task agents may inherit from the server, on top of the basics
   * and each tool's own variables (ANTHROPIC_*, OPENAI_*, ...). Other variables, and every BOOF_*
   * one, are not passed on.
   */
  agentEnv: z.array(EnvNameSchema).max(100).optional(),
});
export type RunnerSettings = z.infer<typeof RunnerSettingsSchema>;

/**
 * The `schemaVersion` written by this release. Absent in settings.json means v1.
 * 2 is a 0.3.0 file: the first start stamps it to 3 and changes nothing else.
 * 0.3.0 refuses any other version, so a stamped root cannot be opened by 0.3.0.
 */
export const SETTINGS_SCHEMA_VERSION = 3 as const;

/** settings.json (directory layout v2). `schemaVersion` is {@link SETTINGS_SCHEMA_VERSION}. */
export const SettingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  runner: RunnerSettingsSchema,
  /** Project the legacy /api/tasks routes and the UI start on; null when unset. */
  defaultProject: kebab.nullable().default(null),
  /** Where `auto` and the UI's default create project directories; `~` expands. Unset: `~/boof-projects`. */
  projectsRoot: z.string().min(1).optional(),
  roles: RolesSchema,
  review: ReviewSettingsSchema.optional(),
  worktree: WorktreeSettingsSchema.optional(),
  retries: RetrySettingsSchema.optional(),
  budget: BudgetSettingsSchema.optional(),
  security: SecuritySettingsSchema.optional(),
  mcp: McpSettingsSchema.optional(),
  /** Console assistant switch and limits. Absent: the defaults from `conciergeSettings`. */
  concierge: ConciergeSettingsSchema.optional(),
  /** The optional better-ccflare account pool. */
  owlish: OwlishSettingsSchema.optional(),
  /** Webhook subscriptions; managed through the webhooks operations (admin), never PUT /settings. */
  webhooks: z.array(WebhookSchema).optional(),
  /** The optional n8n instance; managed through the n8n operations, never PUT /settings. */
  n8n: N8nSettingsSchema.optional(),
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
        inheritMcpServers: z.boolean().optional(),
        agentEnv: z.array(EnvNameSchema).max(100).optional(),
      })
      .optional(),
    defaultProject: kebab.nullable().optional(),
    projectsRoot: z.string().trim().min(1).max(4096).nullable().optional(),
    roles: RolesSchema.optional(),
    review: ReviewSettingsSchema.optional(),
    worktree: WorktreeSettingsSchema.optional(),
    retries: RetrySettingsSchema.optional(),
    budget: BudgetSettingsSchema.optional(),
    /** The account pool; `null` removes it (the key is handled by settings.update, never stored here). */
    owlish: OwlishSettingsSchema.nullable().optional(),
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

/** Per-project authentication choice for the opt-in Claude Agent SDK tool. */
export const ClaudeAgentProjectSchema = z.strictObject({
  auth: z.enum(["gateway", "project-key"]).default("gateway"),
});
export type ClaudeAgentProject = z.infer<typeof ClaudeAgentProjectSchema>;

export const ANTHROPIC_API_KEY_PATTERN = /^sk-ant-api\d{2}-[\x21-\x7e]{16,500}$/;

export function isAnthropicApiKey(v: unknown): v is string {
  return typeof v === "string" && ANTHROPIC_API_KEY_PATTERN.test(v);
}

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
  /** What the project is for; given to every agent prompt as `## Project`. Absent on projects created before 0.3. */
  brief: z.string().optional(),
  claudeAgent: ClaudeAgentProjectSchema.optional(),
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
  /** External (n8n) steps, at most 10. */
  externalSteps: ExternalStepsSchema.optional(),
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
    brief: z.string().trim().max(20_000).nullable(),
    claudeAgent: ClaudeAgentProjectSchema.nullable(),
    paused: z.boolean(),
    archived: z.boolean(),
    defaultBase: z.string().min(1).nullable(),
    roles: ProjectRolesOverrideSchema.nullable(),
    review: ProjectReviewOverrideSchema.nullable(),
    worktree: ProjectWorktreeOverrideSchema.nullable(),
    retries: ProjectRetriesOverrideSchema.nullable(),
    budget: ProjectBudgetOverrideSchema.nullable(),
    externalSteps: ExternalStepsSchema.nullable(),
    planWriteBack: z.boolean(),
    labels: z.array(z.string().max(100)).max(50),
  })
  .partial();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
