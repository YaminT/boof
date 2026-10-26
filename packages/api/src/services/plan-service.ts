import { ZodError } from "zod";
import {
  applyGoalInputs,
  exportPlanXml,
  GoalInputSchema,
  hasScope,
  isValidTopologicalOrder,
  PlanExistsError,
  PlanNotFoundError,
  PlanStore,
  PlanValidationError,
  PlanVersionConflict,
  securitySettings,
  TaskStore,
  uniqueKebabId,
  withApproval,
  withGoalStatus,
  type Goal,
  type GoalStatus,
  type Plan,
  type PlanSource,
  type PlanStatus,
  type Principal,
} from "@boof-runner/shared";
import {
  archiveRemovedGoalTasks,
  importFromRepo,
  mergeImportedGoals,
  PlanNotActiveError,
  syncPlan,
  taskStatusForPlan,
  type SyncResult,
} from "@boof-runner/runner";
import type { z } from "zod";
import { formatIssues, OpError } from "../errors.js";
import { statusDowngraded, type Warning } from "../warnings.js";
import type { TaskService } from "./service.js";

type GoalInputParsed = z.output<typeof GoalInputSchema>;

/** A plan in a listing: everything but the goals, plus counts. */
export interface PlanSummary extends Omit<Plan, "goals"> {
  goalCount: number;
  doneCount: number;
}

export interface CreatePlanInput {
  id?: string;
  title: string;
  description?: string;
  status?: PlanStatus;
  autoSync?: boolean;
  bumpTo?: Plan["bumpTo"];
  goals?: GoalInputParsed[];
}

export interface UpdatePlanInput {
  title?: string;
  description?: string;
  status?: PlanStatus;
  autoSync?: boolean;
  bumpTo?: Plan["bumpTo"];
}

/** Why a plan cannot go on by itself. `status` is the live task's status, `blocked`, `no-task` or `plan-not-active`. */
export interface StuckReason {
  goalId: string;
  taskId: string | null;
  status: string;
}

export interface PlanProgress {
  plan: Plan;
  version: number;
  complete: boolean;
  stuck: boolean;
  stuckReasons: StuckReason[];
}

export interface WaitPlanResult extends PlanProgress {
  changed: boolean;
  timedOut: boolean;
}

export interface ImportInput {
  planId?: string;
  /** Update an existing plan (matching goals by path, then id) instead of refusing. */
  merge?: boolean;
  title?: string;
  status?: PlanStatus;
  autoSync?: boolean;
  bumpTo?: Plan["bumpTo"];
}

export interface ImportResult {
  plan: Plan;
  added: string[];
  updated: string[];
  unchanged: string[];
  warnings: string[];
}

const SOURCE_KIND = { harness: "api", mcp: "mcp", ui: "ui", cli: "api" } as const;

/** Turn the errors of the plan layer into API errors (status + stable code). */
export function mapPlanError(err: unknown): unknown {
  if (err instanceof PlanVersionConflict) {
    return new OpError(409, err.message, "plan_version_conflict", {
      currentVersion: err.currentVersion,
      expectedVersion: err.expectedVersion,
    });
  }
  if (err instanceof PlanNotFoundError) {
    return new OpError(404, err.message, "plan_not_found");
  }
  if (err instanceof PlanExistsError) {
    return new OpError(409, err.message, "plan_exists");
  }
  if (err instanceof PlanNotActiveError) {
    return new OpError(409, err.message, "plan_not_active", { status: err.status });
  }
  if (err instanceof PlanValidationError) {
    return new OpError(400, err.message, "invalid_plan", err.issues);
  }
  if (err instanceof ZodError) {
    return new OpError(400, "Invalid plan", "invalid_plan", formatIssues(err));
  }
  return err;
}

/**
 * Plan operations for ONE project (plan model, section 3). Every write goes through
 * PlanStore.modify, so the stored version is checked (`expectedVersion`) or, when the caller
 * gives none, the change is applied to the latest version.
 */
export class PlanService {
  private readonly store: PlanStore;

  constructor(
    private readonly parent: TaskService,
    readonly projectId: string,
    private readonly projectDir: string,
  ) {
    this.store = new PlanStore(projectDir);
  }

  /** True for a review-trust client while `externalTasksRequireApproval` is on (the default). */
  private async restricted(actor?: Principal): Promise<boolean> {
    if (!actor || actor.kind !== "client" || actor.trust !== "review") return false;
    return securitySettings(await this.parent.loadSettings()).externalTasksRequireApproval;
  }

  /** A restricted client may not change a plan a human activated: its edits would reach the queue unreviewed. */
  private async assertMayEdit(plan: Plan, actor?: Principal): Promise<void> {
    if (plan.status === "active" && (await this.restricted(actor))) {
      throw new OpError(
        403,
        "This client has review trust and cannot change an active plan; set it back to draft (PUT status draft) or ask a human",
        "forbidden_trust",
      );
    }
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapPlanError(err);
    }
  }

  async list(): Promise<PlanSummary[]> {
    return this.run(async () =>
      (await this.store.list()).map(({ goals, ...rest }) => ({
        ...rest,
        goalCount: goals.length,
        doneCount: goals.filter((g) => g.status === "done").length,
      })),
    );
  }

  async get(planId: string): Promise<Plan> {
    return this.run(() => this.store.require(planId));
  }

  /**
   * Where a plan stands: `complete` when every goal is done; `stuck` when a goal's live task
   * failed or waits for answers, or when no task can run (blocked goals, draft tasks, goals
   * without a task). Task statuses are read from the task files.
   */
  async progress(planId: string): Promise<PlanProgress> {
    const plan = await this.get(planId);
    const complete = plan.goals.length > 0 && plan.goals.every((g) => g.status === "done");
    const base = { plan, version: plan.version, complete };
    if (complete || plan.goals.length === 0) {
      return { ...base, stuck: false, stuckReasons: [] };
    }
    const tasks = new TaskStore(this.projectDir);
    const reasons: StuckReason[] = [];
    const rest: StuckReason[] = [];
    let runnable = false;
    for (const g of plan.goals) {
      if (g.status === "done") continue;
      const task = g.taskId ? await tasks.get(g.taskId) : null;
      const status = task?.frontmatter.status;
      if (task && (status === "failed" || status === "action")) {
        reasons.push({ goalId: g.id, taskId: g.taskId, status });
      } else if (task && status === "running") {
        runnable = true;
      } else if (task && status === "pending" && !task.frontmatter.skip) {
        runnable = true;
      } else {
        const blocked = g.dependsOn.some(
          (d) => plan.goals.find((x) => x.id === d)?.status !== "done",
        );
        if (!task && !blocked && plan.status === "active" && plan.autoSync) {
          runnable = true; // the runner creates this goal's task on its next sync
        }
        rest.push({
          goalId: g.id,
          taskId: g.taskId,
          status: blocked
            ? "blocked"
            : task
              ? (status ?? "no-task")
              : plan.status === "active"
                ? "no-task"
                : "plan-not-active",
        });
      }
    }
    if (reasons.length === 0 && !runnable) reasons.push(...rest);
    return { ...base, stuck: reasons.length > 0, stuckReasons: reasons };
  }

  /**
   * Long-poll a plan: returns at once when it is complete or stuck, otherwise when its version
   * goes past `sinceVersion` (default: the version now) or after `timeoutMs`.
   */
  async waitFor(
    planId: string,
    opts: { sinceVersion?: number; timeoutMs: number; pollMs?: number },
  ): Promise<WaitPlanResult> {
    const first = await this.progress(planId);
    const since = opts.sinceVersion ?? first.version;
    const deadline = Date.now() + opts.timeoutMs;
    let now = first;
    for (;;) {
      if (now.complete || now.stuck)
        return { ...now, changed: now.version > since, timedOut: false };
      if (now.version > since) return { ...now, changed: true, timedOut: false };
      if (Date.now() >= deadline) return { ...now, changed: false, timedOut: true };
      await new Promise((r) =>
        setTimeout(r, Math.max(1, Math.min(opts.pollMs ?? 500, deadline - Date.now()))),
      );
      now = await this.progress(planId);
    }
  }

  async createPlan(
    input: CreatePlanInput,
    actor?: Principal,
  ): Promise<Plan & { warnings?: Warning[] }> {
    const restricted = await this.restricted(actor);
    const status: PlanStatus = restricted ? "draft" : (input.status ?? "draft");
    const warnings =
      restricted && input.status && input.status !== "draft"
        ? [statusDowngraded("plan", input.status, "draft")]
        : [];
    const by = actor?.id ?? "local";
    const plan = await this.run(async () => {
      const existing = (await this.store.list()).map((p) => p.id);
      const id = input.id ?? uniqueKebabId(input.title, existing);
      const source: PlanSource =
        actor?.kind === "client"
          ? { kind: SOURCE_KIND[actor.clientKind ?? "harness"], client: actor.id }
          : { kind: "ui" };
      const goals = applyGoalInputs([], input.goals ?? [], { replace: true });
      return this.store.create(
        {
          id,
          title: input.title,
          description: input.description ?? "",
          status,
          autoSync: input.autoSync ?? false,
          bumpTo: input.bumpTo ?? "done",
          // A trusted or local principal that creates an active plan approves it at once.
          ...(status === "active"
            ? { approvedBy: { principalId: by, at: new Date().toISOString(), version: 1 } }
            : {}),
          source,
          goals,
        },
        { by },
      );
    });
    return warnings.length > 0 ? { ...plan, warnings } : plan;
  }

  async updatePlan(
    planId: string,
    patch: UpdatePlanInput,
    expectedVersion: number | undefined,
    actor?: Principal,
  ): Promise<Plan> {
    const restricted = await this.restricted(actor);
    if (restricted && patch.status === "active") {
      throw new OpError(
        403,
        "This client has review trust and cannot activate a plan; a human must approve it",
        "forbidden_trust",
      );
    }
    // A restricted client may pull an active plan back to draft (and nothing else in that edit):
    // that stops new task creation and clears the approval, and leaves running tasks alone.
    const selfDraft =
      restricted &&
      patch.status === "draft" &&
      Object.entries(patch).every(([k, v]) => k === "status" || v === undefined);
    return this.run(() =>
      this.store.modify(
        planId,
        async (plan) => {
          if (!selfDraft) await this.assertMayEdit(plan, actor);
          const next: Plan = {
            ...plan,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.autoSync !== undefined ? { autoSync: patch.autoSync } : {}),
            ...(patch.bumpTo !== undefined ? { bumpTo: patch.bumpTo } : {}),
          };
          // Approval follows the status: a trusted principal that activates a plan approves it,
          // staying active keeps the approval, leaving active clears it.
          return restricted && !selfDraft ? next : withApproval(plan, next, actor?.id ?? "local");
        },
        { expectedVersion, by: actor?.id ?? "local" },
      ),
    );
  }

  /** Whole-DAG replacement: goals not listed are removed; revisions bump per changed goal. */
  async replaceGoals(
    planId: string,
    goals: GoalInputParsed[],
    expectedVersion: number | undefined,
    actor?: Principal,
  ): Promise<Plan> {
    return this.run(() =>
      this.store.modify(
        planId,
        async (plan) => {
          await this.assertMayEdit(plan, actor);
          return { ...plan, goals: applyGoalInputs(plan.goals, goals, { replace: true }) };
        },
        { expectedVersion, by: actor?.id ?? "local" },
      ),
    );
  }

  async upsertGoal(
    planId: string,
    goal: GoalInputParsed,
    expectedVersion: number | undefined,
    actor?: Principal,
  ): Promise<Plan> {
    return this.run(() =>
      this.store.modify(
        planId,
        async (plan) => {
          await this.assertMayEdit(plan, actor);
          return { ...plan, goals: applyGoalInputs(plan.goals, [goal], { replace: false }) };
        },
        { expectedVersion, by: actor?.id ?? "local" },
      ),
    );
  }

  /**
   * Remove a goal. Refused (409 `goal_has_dependents`) while other goals depend on it, unless
   * `cascade` also removes everything downstream. Pending/draft tasks of the removed goals are
   * archived; running ones are asked to stop only with `stopRunning` (needs `tasks:control`).
   */
  async removeGoal(
    planId: string,
    goalId: string,
    expectedVersion: number | undefined,
    opts: { cascade?: boolean; stopRunning?: boolean } = {},
    actor?: Principal,
  ): Promise<Plan> {
    if (opts.stopRunning && actor && !hasScope(actor, "tasks:control")) {
      throw new OpError(
        403,
        "Stopping a running task needs the tasks:control scope",
        "forbidden_scope",
        {
          scopes: ["tasks:control"],
        },
      );
    }
    return this.run(async () => {
      const plan = await this.store.modify(
        planId,
        async (current) => {
          await this.assertMayEdit(current, actor);
          if (!current.goals.some((g) => g.id === goalId)) {
            throw new OpError(404, `Goal not found: ${goalId}`, "goal_not_found");
          }
          const doomed = new Set([goalId]);
          for (let grew = true; grew;) {
            grew = false;
            for (const g of current.goals) {
              if (!doomed.has(g.id) && g.dependsOn.some((d) => doomed.has(d))) {
                doomed.add(g.id);
                grew = true;
              }
            }
          }
          if (doomed.size > 1 && !opts.cascade) {
            const dependents = [...doomed].filter((id) => id !== goalId);
            throw new OpError(
              409,
              `Other goals depend on ${goalId}: ${dependents.join(", ")}`,
              "goal_has_dependents",
              { dependents },
            );
          }
          return { ...current, goals: current.goals.filter((g) => !doomed.has(g.id)) };
        },
        { expectedVersion, by: actor?.id ?? "local" },
      );
      await archiveRemovedGoalTasks({
        projectDir: this.projectDir,
        plan,
        stopRunning: opts.stopRunning,
      });
      return plan;
    });
  }

  /** `orderedIds` must list every goal once, dependencies first. */
  async reorderGoals(
    planId: string,
    orderedIds: string[],
    expectedVersion: number | undefined,
    actor?: Principal,
  ): Promise<Plan> {
    return this.run(() =>
      this.store.modify(
        planId,
        async (plan) => {
          await this.assertMayEdit(plan, actor);
          if (!isValidTopologicalOrder(plan.goals, orderedIds)) {
            throw new PlanValidationError([
              {
                path: "order",
                message:
                  "order must list every goal exactly once with each goal after its dependencies",
              },
            ]);
          }
          const position = new Map(orderedIds.map((id, i) => [id, i + 1]));
          return {
            ...plan,
            goals: plan.goals.map((g) => ({ ...g, order: position.get(g.id)! })),
          };
        },
        { expectedVersion, by: actor?.id ?? "local" },
      ),
    );
  }

  async setGoalStatus(
    planId: string,
    goalId: string,
    status: GoalStatus,
    description: string | undefined,
    expectedVersion: number | undefined,
    actor?: Principal,
  ): Promise<Plan> {
    return this.run(() =>
      this.store.modify(
        planId,
        async (plan) => {
          await this.assertMayEdit(plan, actor);
          if (!plan.goals.some((g) => g.id === goalId)) {
            throw new OpError(404, `Goal not found: ${goalId}`, "goal_not_found");
          }
          const by = actor ? `${actor.kind === "client" ? "client " : ""}${actor.id}` : "a user";
          return {
            ...plan,
            goals: plan.goals.map((g): Goal =>
              g.id === goalId
                ? withGoalStatus(g, status, description?.trim() || `status set by ${by}`)
                : g,
            ),
          };
        },
        { expectedVersion, by: actor?.id ?? "local" },
      ),
    );
  }

  /**
   * Import the project's goal.boof.xml / plan.boof.xml files. A new plan has
   * `source.kind = "repo-import"`; an existing one is only touched with `merge`.
   */
  async importFromRepo(
    input: ImportInput,
    expectedVersion: number | undefined,
    actor?: Principal,
  ): Promise<ImportResult> {
    const restricted = await this.restricted(actor);
    return this.run(async () => {
      const current = input.merge ? await this.store.get(input.planId ?? "repo") : null;
      if (current) await this.assertMayEdit(current, actor);
      const project = await this.parent.getProject(this.projectId);
      if (!project.workingDirectory) {
        throw new OpError(400, "The project has no working directory", "invalid_input");
      }
      const imported = await importFromRepo(project.workingDirectory);
      if (imported.goals.length === 0) {
        throw new OpError(
          400,
          `No goal.boof.xml files found under ${project.workingDirectory}`,
          "nothing_to_import",
        );
      }
      const planId = input.planId ?? "repo";
      const existing = await this.store.get(planId);
      if (!existing) {
        const status: PlanStatus = restricted ? "draft" : (input.status ?? "draft");
        const by = actor?.id ?? "local";
        const plan = await this.store.create(
          {
            id: planId,
            title: input.title ?? `Imported from ${project.name}`,
            status,
            ...(status === "active"
              ? { approvedBy: { principalId: by, at: new Date().toISOString(), version: 1 } }
              : {}),
            autoSync: input.autoSync ?? false,
            bumpTo: input.bumpTo ?? "done",
            source: {
              kind: "repo-import",
              ...(actor?.kind === "client" ? { client: actor.id } : {}),
              importedFrom: project.workingDirectory,
            },
            goals: imported.goals,
          },
          { by },
        );
        const downgraded =
          restricted && input.status && input.status !== "draft"
            ? [statusDowngraded("plan", input.status, "draft").message]
            : [];
        return {
          plan,
          added: plan.goals.map((g) => g.id),
          updated: [],
          unchanged: [],
          warnings: [...imported.warnings, ...downgraded],
        };
      }
      if (!input.merge) {
        throw new OpError(
          409,
          `Plan already exists: ${planId}; pass merge to update it from the repository`,
          "plan_exists",
        );
      }
      let summary = { added: [] as string[], updated: [] as string[], unchanged: [] as string[] };
      const plan = await this.store.modify(
        planId,
        async (current) => {
          await this.assertMayEdit(current, actor);
          const merged = mergeImportedGoals(current.goals, imported.goals);
          summary = merged;
          return { ...current, goals: merged.goals };
        },
        { expectedVersion, by: actor?.id ?? "local" },
      );
      return { plan, ...summary, warnings: imported.warnings };
    });
  }

  /** The plan as boof-planner files: `{ "plan.boof.xml": …, "<path>/goal.boof.xml": … }`. Never written into the repo. */
  async exportToXml(planId: string): Promise<Record<string, string>> {
    return this.run(async () => exportPlanXml(await this.store.require(planId)));
  }

  /**
   * Sync an active plan to tasks (see runner/plan-sync). Tasks start in `draft` when the plan
   * came from a review-trust client or the caller is one. 409 `plan_not_active` otherwise.
   */
  async syncTasks(
    planId: string,
    opts: { dryRun?: boolean; stopRunning?: boolean } = {},
    actor?: Principal,
  ): Promise<SyncResult> {
    if (opts.stopRunning && actor && !hasScope(actor, "tasks:control")) {
      throw new OpError(
        403,
        "Stopping a running task needs the tasks:control scope",
        "forbidden_scope",
        {
          scopes: ["tasks:control"],
        },
      );
    }
    const restricted = await this.restricted(actor);
    return this.run(async () => {
      const plan = await this.store.require(planId);
      if (plan.status !== "active") throw new PlanNotActiveError(plan.id, plan.status);
      const project = await this.parent.getProject(this.projectId);
      const settings = await this.parent.loadSettings();
      // A review client's sync stays draft unless a human approved the plan's content.
      const createStatus =
        restricted && !plan.approvedBy
          ? "draft"
          : await taskStatusForPlan(this.parent.root, plan, settings);
      return syncPlan({
        projectDir: this.projectDir,
        project,
        planId,
        dryRun: opts.dryRun,
        stopRunning: opts.stopRunning,
        createStatus,
        by: actor?.id ?? "local",
      });
    });
  }
}
