import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  appendVersion,
  blockingScopes,
  effectiveSettings,
  evaluateBudget,
  resolveRole,
  type BudgetScope,
  parseGoal,
  PlanStore,
  ProjectStore,
  serializeGoal,
  SettingsStore,
  statusDir,
  TaskStore,
  workingAreaDir,
  type Project,
  type Status,
  taskControlDir,
  taskStopRequestPath,
  type Task,
} from "@boof-runner/shared";
import { announceBudgetExceeded } from "./budget.js";
import { syncPlan, taskStatusForPlan } from "./plan-sync.js";
import { Pipeline, SHUTDOWN_STOP_MARKER, type PipelineOutcome } from "./pipeline.js";
import { ToolRegistry } from "./tools/registry.js";
import { isGitRepo, pruneStaleWorktrees } from "./worktree.js";

export interface EngineOptions {
  root: string;
  pollIntervalMs?: number;
  registry?: ToolRegistry;
  /** Only serve this project (headless `run --all --project`). */
  onlyProject?: string;
}

const INTERRUPTED_NOTE =
  "The runner stopped unexpectedly (server restart or crash) while this task was running. Its worktree and branch are kept. Retry it to continue from the kept worktree.";

export type TickResult =
  | { kind: "ran"; outcome: PipelineOutcome; projectId: string }
  | { kind: "idle" }
  | { kind: "disabled" }
  | { kind: "blocked" }
  /** Nothing started because a day budget is spent (`scopes`); work resumes when it resets. */
  | { kind: "budget"; scopes: string[] };

/** The next task to run and the project it belongs to. */
export interface Selection {
  project: Project;
  task: Task;
}

/**
 * Background runner. Polls the pending/ queues of every active, non-paused project, selects
 * one task by global priority, and drives it through the pipeline. Up to
 * `settings.runner.concurrency` tasks run at once, never two in the same project (their
 * worktrees share one repository). Cooperative on/off is checked at the task boundary so
 * in-flight tasks finish gracefully before the loop stops selecting new work.
 */
export class RunnerEngine {
  readonly root: string;
  readonly projects: ProjectStore;
  readonly settingsStore: SettingsStore;
  readonly registry: ToolRegistry;
  private readonly pollIntervalMs: number;
  private readonly onlyProject?: string;
  /** In-flight pipelines by project id (the at-most-one-per-project invariant). */
  private readonly inflight = new Map<string, Promise<TickResult>>();
  /** Task id in flight per project id (so a shutdown can ask each one to stop). */
  private readonly runningTasks = new Map<string, string>();
  /** Day-budget scopes that kept work from starting in the last selection. */
  private budgetBlocked: BudgetScope[] = [];
  private looping = false;
  private stopRequested = false;

  constructor(opts: EngineOptions) {
    this.root = opts.root;
    this.projects = new ProjectStore(opts.root, { isGitRepo });
    this.settingsStore = new SettingsStore(opts.root);
    this.registry = opts.registry ?? new ToolRegistry();
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.onlyProject = opts.onlyProject;
  }

  /** Task store of a project. */
  storeFor(project: Project | string): TaskStore {
    return new TaskStore(this.projects.dir(typeof project === "string" ? project : project.id));
  }

  /** Projects the runner may serve: active, not paused, with a working directory. */
  private async runnableProjects(): Promise<Project[]> {
    const all = await this.projects.list();
    return all.filter(
      (p) =>
        !p.paused && p.workingDirectory !== "" && (!this.onlyProject || p.id === this.onlyProject),
    );
  }

  /**
   * Select the next eligible pending task across projects: highest priority, then oldest
   * `updated`, then project id (then task id) for determinism. Projects with a task in
   * flight are excluded.
   */
  async selectNext(): Promise<Selection | null> {
    return (await this.selectWithBudget()).selection;
  }

  /**
   * {@link selectNext} plus the spent day budgets that kept projects or tasks out of the
   * selection. A project whose day budget is spent, and a task that needs a tool whose day
   * budget is spent (any role's tool), are skipped; a spent global budget skips everything.
   * Each blocking scope is announced once per day with a `runner.budget_exceeded` event.
   */
  private async selectWithBudget(): Promise<{
    selection: Selection | null;
    blocked: BudgetScope[];
  }> {
    const settings = await this.settingsStore.load();
    const projects = await this.runnableProjects();
    const limited = settings.budget !== undefined || projects.some((p) => p.budget !== undefined);
    const status = limited ? await evaluateBudget(this.root, settings, projects) : null;
    const blocked = new Map<string, BudgetScope>();
    const global = status?.exceeded.find((s) => s.scope === "global");
    if (global) blocked.set(global.scope, global);
    let best: Selection | null = null;
    for (const project of projects) {
      if (this.inflight.has(project.id)) continue;
      for (const task of await this.storeFor(project).list()) {
        if (task.frontmatter.status !== "pending" || task.frontmatter.skip) continue;
        if (status) {
          const eff = effectiveSettings(settings, project);
          const tools = (["planner", "developer", "reviewer", "observer"] as const)
            .map((role) => resolveRole(eff, task, role as "observer")?.tool)
            .filter((t): t is string => t !== undefined);
          const hits = blockingScopes(status, project.id, tools);
          if (hits.length > 0) {
            for (const h of hits) blocked.set(h.scope, h);
            continue;
          }
        }
        if (!best || compareSelection({ project, task }, best) < 0) best = { project, task };
      }
    }
    if (status) {
      for (const scope of blocked.values()) await announceBudgetExceeded(this.root, status, scope);
    }
    return { selection: best, blocked: [...blocked.values()] };
  }

  /**
   * Record a plan task's new status in its goal's `tasks` list. Best effort: it never fails the
   * task, and a goal without that entry (an older plan) is left for the next sync to fill in.
   */
  private async noteGoalTaskStatus(project: Project, task: Task, status: Status): Promise<void> {
    const ref = task.frontmatter.planRef;
    if (!ref) return;
    const id = task.frontmatter.id;
    try {
      await new PlanStore(this.projects.dir(project.id)).modify(ref.planId, (plan) => {
        const goal = plan.goals.find((g) => g.id === ref.goalId);
        const entry = goal?.tasks.find((t) => t.taskId === id);
        if (!goal || !entry || entry.status === status) return plan;
        return {
          ...plan,
          goals: plan.goals.map((g) =>
            g.id !== goal.id
              ? g
              : { ...g, tasks: g.tasks.map((t) => (t.taskId === id ? { ...t, status } : t)) },
          ),
        };
      });
    } catch (err) {
      console.error(`could not record the status of ${id} in its plan:`, err);
    }
  }

  /** Transition pending → running and scaffold the working area. */
  private async startTask(
    project: Project,
    store: TaskStore,
    dir: string,
    id: string,
  ): Promise<Task> {
    const task = await store.transition(id, "running");
    await this.noteGoalTaskStatus(project, task, "running");
    const area = workingAreaDir(dir, id);
    await mkdir(join(area, "reports"), { recursive: true });
    await writeFile(join(area, "log.txt"), "", { flag: "a" });
    await writeFile(join(area, "plan.md"), "", { flag: "a" });
    return task;
  }

  private async finalize(
    project: Project,
    store: TaskStore,
    outcome: PipelineOutcome,
  ): Promise<void> {
    const id = outcome.task.frontmatter.id;
    if (outcome.kind === "done") {
      // Count this completed run. If more runs were requested, re-queue the
      // task to pending for its next iteration; otherwise finish (runs feature).
      const current = (await store.get(id)) ?? outcome.task;
      const completed = current.frontmatter.completedRuns + 1;
      const runs = current.frontmatter.runs;
      const next = completed < runs ? "pending" : "done";
      await store.transition(id, next, (t) => {
        t.frontmatter.completedRuns = completed;
      });
      if (next === "pending") await this.noteGoalTaskStatus(project, outcome.task, "pending");
      if (next === "done" && outcome.task.frontmatter.planRef) {
        await this.recordPlanDone(project, outcome.task).catch((err) =>
          console.error(`plan status write-back failed for ${id}:`, err),
        );
      } else if (next === "done" && outcome.task.frontmatter.boofGoal) {
        // Legacy scan task: bump its goal.boof.xml status.
        await this.bumpGoalFile(project, outcome.task).catch(() => {});
      }
    } else if (outcome.kind === "failed") {
      await store.transition(
        id,
        "failed",
        undefined,
        outcome.budget ? { reason: outcome.error } : undefined,
      );
      await this.noteGoalTaskStatus(project, outcome.task, "failed");
    } else if (outcome.kind === "stopped") {
      // Only a stop request gets here (user stop, plan goal removed, server shutdown). The
      // worktree and branch are kept; retrying the task continues in them.
      await store.transition(id, "stopped", undefined, { reason: outcome.note });
      await this.noteGoalTaskStatus(project, outcome.task, "stopped");
    } else {
      // Parked: record questions, set questions=pending, move to actions/.
      await store.transition(id, "action", (t) => {
        t.frontmatter.questions = "pending";
        t.body.questions = outcome.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
      });
      await this.noteGoalTaskStatus(project, outcome.task, "action");
    }
  }

  /**
   * A plan task finished: record the goal's new status (`plan.bumpTo`) in the plan history at
   * the revision the task was built from, clear the goal's live task, and, when the goal has a
   * `path` and the project enables `planWriteBack`, append the same version to the repo's
   * goal.boof.xml. The plan write retries against concurrent API edits (PlanStore.modify).
   * Write-back failures are logged and never fail the task.
   */
  private async recordPlanDone(project: Project, task: Task): Promise<void> {
    const ref = task.frontmatter.planRef;
    if (!ref) return;
    const taskId = task.frontmatter.id;
    const description = `boof-runner completed task ${taskId}`;
    let path: string | undefined;
    let bumpTo: "review" | "done" = "done";
    await new PlanStore(this.projects.dir(project.id)).modify(ref.planId, (plan) => {
      const goal = plan.goals.find((g) => g.id === ref.goalId);
      if (!goal) return plan;
      path = goal.path;
      bumpTo = plan.bumpTo;
      return {
        ...plan,
        goals: plan.goals.map((g) =>
          g.id !== goal.id
            ? g
            : {
                ...g,
                // A task that finished at an older revision leaves the goal open again.
                status: ref.revision < g.revision ? "develop" : plan.bumpTo,
                taskId: g.taskId === taskId ? null : g.taskId,
                tasks: g.tasks.map((t) => (t.taskId === taskId ? { ...t, status: "done" } : t)),
                history: [
                  ...g.history,
                  {
                    revision: ref.revision,
                    status: plan.bumpTo,
                    description,
                    at: new Date().toISOString(),
                    taskId,
                  },
                  ...(ref.revision < g.revision
                    ? [
                        {
                          revision: g.revision,
                          status: "develop" as const,
                          description: `spec changed to revision ${g.revision}`,
                          at: new Date().toISOString(),
                        },
                      ]
                    : []),
                ],
              },
        ),
      };
    });
    if (path === undefined || !project.planWriteBack) return;
    try {
      const rel = relative(project.workingDirectory, join(project.workingDirectory, path));
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`goal path escapes the repo: ${path}`);
      const goalPath = join(project.workingDirectory, path, "goal.boof.xml");
      const goal = parseGoal(await readFile(goalPath, "utf8"));
      await writeFile(
        goalPath,
        serializeGoal(appendVersion(goal, bumpTo, `${description}.`)),
        "utf8",
      );
    } catch (err) {
      console.error(`could not write goal status back for ${taskId}:`, err);
    }
  }

  /**
   * Sync every `active` plan with `autoSync` of the projects the runner serves, so goals that
   * became unblocked or changed turn into tasks before the next selection. Errors are logged;
   * they never stop the loop.
   */
  async syncAutoPlans(): Promise<void> {
    let settings;
    try {
      settings = await this.settingsStore.load();
    } catch {
      return;
    }
    for (const project of await this.runnableProjects().catch(() => [] as Project[])) {
      const projectDir = this.projects.dir(project.id);
      let plans;
      try {
        plans = await new PlanStore(projectDir).list();
      } catch {
        continue;
      }
      for (const plan of plans) {
        if (plan.status !== "active" || !plan.autoSync) continue;
        try {
          await syncPlan({
            projectDir,
            project,
            planId: plan.id,
            createStatus: await taskStatusForPlan(this.root, plan, settings),
          });
        } catch (err) {
          console.error(`plan sync failed for ${project.id}/${plan.id}:`, err);
        }
      }
    }
  }

  /**
   * Append a version to a scanned unit's goal.boof.xml, bumping its status
   * (goal-ingestion write-back). The path is relative to the project's working directory
   * (the scanned repo). Best-effort: failures are swallowed by the caller so a
   * successful task is never marked failed just because status write-back broke.
   */
  private async bumpGoalFile(project: Project, task: Task): Promise<void> {
    const ref = task.frontmatter.boofGoal;
    if (!ref) return;
    const goalPath = join(project.workingDirectory, ref.path);
    const goal = parseGoal(await readFile(goalPath, "utf8"));
    const bumped = appendVersion(
      goal,
      ref.bumpTo,
      `boof-runner completed task ${task.frontmatter.id}.`,
    );
    await writeFile(goalPath, serializeGoal(bumped), "utf8");
  }

  /**
   * Start `sel` and register it as in flight for its project. The caller must not start a
   * second selection for the same project before the returned promise settles; selectNext
   * guarantees that by excluding in-flight projects.
   */
  private start(sel: Selection): Promise<TickResult> {
    const { project } = sel;
    const run = async (): Promise<TickResult> => {
      const dir = this.projects.dir(project.id);
      const store = this.storeFor(project);
      const id = sel.task.frontmatter.id;
      this.runningTasks.set(project.id, id);
      await this.startTask(project, store, dir, id);
      const running = await store.get(id);
      const settings = await this.settingsStore.load();
      const pipeline = new Pipeline({
        root: dir,
        store,
        registry: this.registry,
        settings: effectiveSettings(settings, project),
        project,
        dataRoot: this.root,
      });
      const outcome = await pipeline.run(running!);
      await this.finalize(project, store, outcome);
      return { kind: "ran", outcome, projectId: project.id };
    };
    const p = run().finally(() => {
      this.inflight.delete(project.id);
      this.runningTasks.delete(project.id);
    });
    this.inflight.set(project.id, p);
    return p;
  }

  /** Process at most one task. Returns what happened. */
  async tick(): Promise<TickResult> {
    const settings = await this.settingsStore.load();
    if (!settings.runner.enabled) return { kind: "disabled" };

    await this.syncAutoPlans();
    const { selection, blocked } = await this.selectWithBudget();
    if (!selection) {
      return blocked.length > 0
        ? { kind: "budget", scopes: blocked.map((b) => b.scope) }
        : { kind: "idle" };
    }
    return this.start(selection);
  }

  /**
   * Start tasks until the concurrency limit is reached or nothing more is selectable.
   * Returns the promises of the tasks started.
   */
  private async fill(concurrency: number): Promise<Promise<TickResult>[]> {
    const started: Promise<TickResult>[] = [];
    await this.syncAutoPlans();
    this.budgetBlocked = [];
    while (this.inflight.size < concurrency && !this.stopRequested) {
      const { selection: next, blocked } = await this.selectWithBudget();
      this.budgetBlocked = blocked;
      if (!next) break;
      const p = this.start(next);
      p.catch((err) => console.error("task failed to run:", err)); // runUntilIdle rethrows via race
      started.push(p);
    }
    return started;
  }

  /**
   * Drain the queues until idle/disabled, honouring `runner.concurrency` (used by tests
   * and headless `run --all`). Resolves with one result per finished task in completion
   * order, followed by a final `idle` (or `disabled`) result.
   */
  async runUntilIdle(maxTasks = 1000): Promise<TickResult[]> {
    const results: TickResult[] = [];
    const all: Promise<unknown>[] = [];
    let launched = 0;
    for (;;) {
      const settings = await this.settingsStore.load();
      if (settings.runner.enabled && launched < maxTasks) {
        const room = Math.min(
          settings.runner.concurrency,
          this.inflight.size + maxTasks - launched,
        );
        for (const p of await this.fill(room)) {
          launched += 1;
          all.push(
            p.then(
              (r) => void results.push(r),
              () => {},
            ),
          );
        }
      }
      if (this.inflight.size === 0) {
        await Promise.all(all);
        results.push(
          !settings.runner.enabled
            ? { kind: "disabled" }
            : this.budgetBlocked.length > 0
              ? { kind: "budget", scopes: this.budgetBlocked.map((b) => b.scope) }
              : { kind: "idle" },
        );
        return results;
      }
      await Promise.race(this.inflight.values());
    }
  }

  /**
   * Recover tasks a dead runner left in `running` (crash, SIGKILL, OOM, reboot). Call it only
   * from the process that holds the runner guard, before selecting work: nothing else is
   * driving those tasks. Each one gets an Interrupted block (live log mirrored into the body
   * first) and moves to `failed`; its worktree and branch are kept so a retry resumes there.
   * Entries with no readable task.md are skipped with a warning. Returns the recovered ids.
   */
  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = [];
    for (const project of await this.projects.list().catch(() => [] as Project[])) {
      const dir = this.projects.dir(project.id);
      const store = this.storeFor(project);
      let ids: string[];
      try {
        ids = (await readdir(statusDir(dir, "running"), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          const located = await store.locate(id);
          if (!located || located.status !== "running") {
            console.warn(`recovery: skipping ${project.id}/${id}: no task.md in ongoing/${id}`);
            continue;
          }
          const live = await readFile(join(workingAreaDir(dir, id), "log.txt"), "utf8").catch(
            () => "",
          );
          const task = await store.transition(
            id,
            "failed",
            (t) => {
              if (live.trim()) t.body.log = live;
              const block = `### Interrupted\n${INTERRUPTED_NOTE}`;
              t.body.log = t.body.log.trim() ? `${t.body.log.trimEnd()}\n\n${block}` : block;
            },
            { reason: "interrupted: runner stopped unexpectedly" },
          );
          await this.noteGoalTaskStatus(project, task, "failed");
          recovered.push(id);
        } catch (err) {
          console.warn(`recovery: skipping ${project.id}/${id}:`, err);
        }
      }
    }
    if (recovered.length > 0) {
      console.log(`Recovered ${recovered.length} interrupted task(s): ${recovered.join(", ")}`);
    }
    return recovered;
  }

  /** Long-running loop. Honors cooperative stop and the enabled flag. */
  async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    this.stopRequested = false;
    await this.recoverInterrupted().catch((err) => console.error("task recovery failed:", err));
    for (const project of await this.projects.list().catch(() => [])) {
      if (project.workingDirectory) {
        await pruneStaleWorktrees(project.workingDirectory).catch(() => {});
      }
    }
    try {
      while (!this.stopRequested) {
        try {
          const settings = await this.settingsStore.load();
          if (settings.runner.enabled) await this.fill(settings.runner.concurrency);
          const waits: Promise<unknown>[] = [this.sleep(this.pollIntervalMs)];
          if (this.inflight.size > 0)
            waits.push(...[...this.inflight.values()].map((p) => p.catch(() => {})));
          await Promise.race(waits);
        } catch (err) {
          console.error("runner loop error:", err);
          await this.sleep(this.pollIntervalMs);
        }
      }
    } finally {
      await Promise.allSettled([...this.inflight.values()]);
      this.looping = false;
    }
  }

  stop(): void {
    this.stopRequested = true;
  }

  /**
   * Graceful shutdown (SIGTERM under systemd): stop selecting new work, ask every running task
   * to stop through its stop-request file (the tool process group gets SIGTERM, then SIGKILL;
   * the pipeline records the task as `stopped` ("stopped by server shutdown") with its worktree
   * kept, so it can be retried), and
   * wait up to `graceMs` for the pipelines to finish. Returns the ids asked to stop and whether
   * some were still running when the grace period ended.
   */
  async shutdown(graceMs = 30_000): Promise<{ stopped: string[]; timedOut: boolean }> {
    this.stop();
    const stopped: string[] = [];
    for (const [projectId, id] of [...this.runningTasks]) {
      const dir = this.projects.dir(projectId);
      try {
        await mkdir(taskControlDir(dir, id), { recursive: true });
        await writeFile(
          taskStopRequestPath(dir, id),
          `${SHUTDOWN_STOP_MARKER} ${new Date().toISOString()}\n`,
          "utf8",
        );
        await appendFile(
          join(workingAreaDir(dir, id), "log.txt"),
          `\n\n### Stop requested\nRunner shutting down at ${new Date().toISOString()}\n`,
          "utf8",
        ).catch(() => {});
        stopped.push(id);
      } catch (err) {
        console.error(`could not request stop for ${id}:`, err);
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), graceMs);
    });
    const drained = Promise.allSettled([...this.inflight.values()]).then(() => "drained" as const);
    const result = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    return { stopped, timedOut: result === "timeout" };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }
}

/** Order: priority desc, `updated` asc, project id asc, task id asc. Negative = a first. */
function compareSelection(a: Selection, b: Selection): number {
  const fa = a.task.frontmatter;
  const fb = b.task.frontmatter;
  if (fb.priority !== fa.priority) return fb.priority - fa.priority;
  const byUpdated = fa.updated.localeCompare(fb.updated);
  if (byUpdated !== 0) return byUpdated;
  if (a.project.id !== b.project.id) return a.project.id < b.project.id ? -1 : 1;
  return fa.id < fb.id ? -1 : fa.id > fb.id ? 1 : 0;
}
