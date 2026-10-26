/** Output (and shared) schemas of the operations. */
import { z } from "zod";
import {
  ClientSchema,
  PlanSchema,
  ProjectSchema,
  BudgetSettingsSchema,
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
    injected: z.string().meta({
      description:
        "Prompts injected while the task ran, as `### <iso time> — <who>` entries; kept after the run.",
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
  currentBranch: z.string().nullable().meta({
    description:
      "Branch checked out in the working directory (git symbolic-ref); null when detached or not a repository.",
  }),
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
