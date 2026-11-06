/** Output (and shared) schemas of the operations. */
import { z } from "zod";
import {
  ClientSchema,
  EpicSchema,
  PlanSchema,
  ProjectSchema,
  BudgetSettingsSchema,
  SettingsSchema,
  TaskFrontmatterSchema,
  TokenUsageSchema,
  WebhookSchema,
} from "@boof/heart";
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
    injected: z.string().meta({
      description:
        "Prompts injected while the task ran, as `### <iso time> — <who>` entries; kept after the run.",
    }),
    /** Only with `include=log` (tasks.get) and on the unversioned routes. */
    log: z.string().optional(),
  }),
  projectId: z.string(),
  /** The effective epic: the task's own, or its parent's for a subtask. Only on list, get, create, move and queue. */
  epicId: z
    .string()
    .optional()
    .meta({ description: "Effective epic (a subtask's is its parent's)." }),
  subtasks: z.object({ total: z.number().int(), done: z.number().int() }).optional().meta({
    description: "Non-archived subtasks and how many are done; present when there are any.",
  }),
  parentMissing: z.literal(true).optional().meta({
    description: "The task names a parent that does not exist; it is listed as a top-level task.",
  }),
  epicMissing: z.literal(true).optional().meta({
    description: "The task's effective epic does not exist in this project.",
  }),
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
  /** The ref the worktree started from: the task's base, else the project's checked-out branch at task start, else HEAD. */
  baseRef: z.string().optional(),
  /** Why plan sync chose that base (from the `## Base` block of the task log). */
  baseReason: z
    .enum([
      "dependency",
      "dependencies-merged",
      "dependency-conflict",
      "follow-up",
      "project-default",
      "head",
    ])
    .optional(),
});

/** The result of a create: the task plus the warnings when the server changed the requested status. */
export const TaskCreateResultSchema = TaskViewSchema.extend({
  warnings: z.array(WarningSchema).optional(),
});

/** The result of a plan create: the plan plus the warnings when the server changed the requested status. */
export const PlanCreateResultSchema = PlanSchema.extend({
  warnings: z.array(WarningSchema).optional(),
});

/** A plan as `plans.get` shows it: the stored plan plus the derived merge order. */
export const PlanViewSchema = PlanSchema.extend({
  mergeOrder: z
    .array(z.object({ goalId: z.string(), taskId: z.string(), branch: z.string() }))
    .meta({
      description:
        "The final task branch of each goal that ran a task, in topological plan order. Merge them in this order.",
    }),
});

/** A project as `projects.get` and `projects.list` show it: the stored project plus the live branch. */
export const ProjectViewSchema = ProjectSchema.extend({
  anthropicApiKeySet: z.boolean(),
  currentBranch: z.string().nullable().meta({
    description:
      "Branch checked out in the working directory (git symbolic-ref); null when detached or not a repository.",
  }),
});

export const AgentSdkEligibilitySchema = z.object({
  gateway: z.enum(["absent", "checked"]),
  allowed: z.boolean(),
  reason: z.string(),
  blocking: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      provider: z.string().nullable(),
      why: z.enum(["subscription", "oauth-token", "unknown-type"]),
    }),
  ),
  checkedAt: z.string(),
});
export const AgentAuthStatusSchema = z.array(
  z.object({
    projectId: z.string(),
    roles: z.array(z.enum(["planner", "developer", "observer", "reviewer"])),
    allowed: z.boolean(),
    via: z.enum(["gateway", "project-key"]).nullable(),
    reason: z.string().nullable(),
  }),
);

/** An epic with its derived progress: non-archived top-level tasks and how many are done. */
export const EpicViewSchema = EpicSchema.extend({
  progress: z.object({ total: z.number().int(), done: z.number().int() }),
});

export const OkSchema = z.object({ ok: z.literal(true) });

/** The result of deleting a task: the ids of the subtasks that were made top-level tasks. */
export const DeleteResultSchema = z.object({
  ok: z.literal(true),
  detached: z
    .array(z.string())
    .meta({ description: "Subtasks that became top-level tasks (detach)." }),
});

export const InjectResultSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["next-step", "now"]),
  applied: z.literal("pending").meta({
    description:
      "The prompt is saved; it reaches the agent when the next step starts (`next-step`) or once the running step is interrupted (`now`). Watch the task log for `### Steered`.",
  }),
});

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

/** A webhook as listed: `notDelivering` says why one that is enabled still sends nothing. */
export const PublicWebhookSchema = WebhookSchema.extend({ notDelivering: z.string().optional() });

const ConciergePendingChangeSchema = z.object({
  id: z.string(),
  op: z.string(),
  title: z.string(),
  details: z.array(z.string()),
  destructive: z.boolean(),
  blocked: z.string().optional(),
  reason: z.enum(["confirm", "needs-approval"]),
  status: z.enum(["pending", "applying", "applied", "discarded", "expired", "failed"]),
  expiresAt: z.string(),
  error: z.string().optional(),
});
const ConciergeTargetSchema = z
  .object({ kind: z.enum(["task", "plan", "epic"]), id: z.string() })
  .nullable();
export const ConciergeStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  via: z.enum(["gateway", "project-key"]).nullable(),
  model: z.string(),
  limits: z.object({
    perMessageUsd: z.number(),
    perConversationUsd: z.number(),
    messagesPerMinute: z.number().int(),
  }),
  conversation: z
    .object({
      id: z.string(),
      spentUsd: z.number(),
      messages: z.number().int(),
      pending: z.array(ConciergePendingChangeSchema),
    })
    .nullable(),
});
export const ConciergeAnswerSchema = z.object({
  conversationId: z.string(),
  text: z.string(),
  changes: z.array(
    z.object({ op: z.string(), summary: z.string(), target: ConciergeTargetSchema }),
  ),
  pending: z.array(ConciergePendingChangeSchema),
  costUsd: z.number().nullable(),
  stopReason: z.enum(["done", "max_turns", "max_budget"]),
});
export const ConciergeChangeSchema = ConciergePendingChangeSchema;
export const ConciergeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation"), conversationId: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    tool: z.string(),
    phase: z.enum(["start", "end"]),
    ok: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("change"),
    op: z.string(),
    summary: z.string(),
    target: ConciergeTargetSchema,
  }),
  z.object({ type: z.literal("pending"), change: ConciergePendingChangeSchema }),
  z.object({ type: z.literal("done"), answer: ConciergeAnswerSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

export const HealthResultSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  message: z.string(),
  version: z.string().optional(),
  unavailableReason: z.string().optional(),
  checkedAt: z
    .string()
    .optional()
    .meta({ description: "ISO-8601 time the check ran in this server process (GET /health)." }),
});

/** One model of a tool, as `models.details` reports it. */
export const ModelDetailSchema = z.object({
  id: z.string(),
  source: z.enum(["cli", "default", "settings"]).meta({
    description:
      "cli: the tool's live model list has it. default: only the built-in defaults have it. settings: only settings.models (or a role) names it.",
  }),
  isDefault: z.boolean().meta({ description: "True when it is the tool's first default model." }),
  usedBy: z.array(z.string()).meta({
    description:
      "Roles (planner, developer, observer, reviewer) whose global assignment uses this tool and model, and project:<id>:<role> for project overrides the caller may access.",
  }),
});

export const ModelDetailsSchema = z.object({
  tools: z.record(
    z.string(),
    z.object({
      displayName: z.string(),
      unavailableReason: z.string().optional(),
      health: HealthResultSchema.extend({
        checkedAt: z.string().meta({
          description: "ISO-8601 time the health check ran in this server process.",
        }),
      })
        .nullable()
        .meta({ description: "Last health result of this process, or null if no check ran." }),
      models: z.array(ModelDetailSchema),
    }),
  ),
});

export const CommandTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
});

/** Result of a rename: `skippedTasks` lists running tasks left on the old template id. */
export const CommandRenameSchema = CommandTemplateSchema.extend({
  skippedTasks: z.array(z.string()).optional(),
});

export const BudgetScopeSchema = z.object({
  scope: z.string(),
  spentUsd: z.number(),
  limitUsd: z.number().nullable(),
  remainingUsd: z.number().nullable(),
  exceeded: z.boolean(),
});

/** Spent-out budgets as `runner.status` and `runner.overview` list them. */
export const BudgetExceededListSchema = z.array(BudgetScopeSchema);

export const BudgetStatusSchema = z.object({
  date: z.string(),
  timezone: z.string(),
  resetsAt: z.string(),
  limits: BudgetSettingsSchema,
  unknownSteps: z.number().int(),
  scopes: z.array(BudgetScopeSchema),
  exceeded: z.array(BudgetScopeSchema),
  projects: z.array(
    z.object({
      id: z.string(),
      perTaskUsd: z.number().nullable(),
      onExceed: z.enum(["pause", "fail"]),
    }),
  ),
});

export { PlanSchema, ProjectSchema, TokenUsageSchema };

const RefShaSchema = z.object({ ref: z.string(), sha: z.string() });

/** What a task changed: its branch against its base, plus a live worktree's uncommitted changes. */
export const TaskDiffSchema = z.object({
  base: RefShaSchema.meta({ description: "The comparison base: the recorded start commit." }),
  head: RefShaSchema.meta({ description: "The task branch boof-runner/<id> and its head commit." }),
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().optional().meta({ description: "Previous path of a renamed file." }),
      status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
  stats: z.object({
    files: z.number().int(),
    additions: z.number().int(),
    deletions: z.number().int(),
  }),
  patch: z.string().optional().meta({
    description:
      "Unified diff. Present when `path` is given (that file only) or the whole diff is within maxBytes.",
  }),
  truncated: z.boolean().meta({
    description:
      "True when the patch was left out (whole diff over maxBytes) or cut at maxBytes (one file).",
  }),
  commits: z
    .array(z.object({ sha: z.string(), subject: z.string(), author: z.string(), date: z.string() }))
    .meta({ description: "Commits on the branch since the base, newest first (at most 200)." }),
  includesUncommitted: z.boolean().optional().meta({
    description:
      "True when the task's live worktree has uncommitted or untracked changes and they are part of files and patch.",
  }),
  leftovers: RefShaSchema.optional().meta({
    description:
      "The <branch>--leftovers side branch holding uncommitted work saved at the end of a run, when it exists.",
  }),
});

/** The account pool as the gateway health check reports it (see `@boof/owlish`). */
export const PoolStatusSchema = z.object({
  status: z.enum(["absent", "unreachable", "ok", "degraded", "unhealthy"]),
  configured: z.number().int().nullable(),
  routable: z.number().int().nullable(),
  paused: z.number().int().nullable(),
  rateLimited: z.number().int().nullable(),
  usageExhausted: z.number().int().nullable(),
  nextAvailableAt: z.string().nullable(),
  reason: z
    .string()
    .nullable()
    .meta({ description: "Why the pool is not ok; at most 200 characters." }),
});

/** One account of the pool; fields the gateway adds later pass through. */
export const AccountSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  provider: z.string().optional(),
  priority: z.number().optional(),
  paused: z.boolean().optional(),
  tokenStatus: z.string().optional(),
  rateLimitStatus: z.string().optional(),
  rateLimitReset: z.union([z.string(), z.number()]).nullable().optional(),
});
