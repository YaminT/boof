import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  appendVersion,
  effectiveSettings,
  parseGoal,
  PlanStore,
  ProjectStore,
  serializeGoal,
  SettingsStore,
  TaskStore,
  workingAreaDir,
  type Project,
  type Status,
  type Task,
} from "@boof-runner/shared";
import { syncPlan, taskStatusForPlan } from "./plan-sync.js";
import { Pipeline, type PipelineOutcome } from "./pipeline.js";
import { ToolRegistry } from "./tools/registry.js";
import { isGitRepo, pruneStaleWorktrees } from "./worktree.js";

export interface EngineOptions {
  root: string;
  pollIntervalMs?: number;
  registry?: ToolRegistry;
  /** Only serve this project (headless `run --all --project`). */
  onlyProject?: string;
}

export type TickResult =
  | { kind: "ran"; outcome: PipelineOutcome; projectId: string }
  | { kind: "idle" }
  | { kind: "disabled" }
  | { kind: "blocked" };

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
    let best: Selection | null = null;
    for (const project of await this.runnableProjects()) {
      if (this.inflight.has(project.id)) continue;
      for (const task of await this.storeFor(project).list()) {
        if (task.frontmatter.status !== "pending" || task.frontmatter.skip) continue;
        if (!best || compareSelection({ project, task }, best) < 0) best = { project, task };
      }
    }
    return best;
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
      const completed = outcome.task.frontmatter.completedRuns + 1;
      const runs = outcome.task.frontmatter.runs;
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
      await store.transition(id, "failed");
      await this.noteGoalTaskStatus(project, outcome.task, "failed");
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
      await this.startTask(project, store, dir, id);
      const running = await store.get(id);
      const settings = await this.settingsStore.load();
      const pipeline = new Pipeline({
        root: dir,
        store,
        registry: this.registry,
        settings: effectiveSettings(settings, project),
        project,
      });
      const outcome = await pipeline.run(running!);
      await this.finalize(project, store, outcome);
      return { kind: "ran", outcome, projectId: project.id };
    };
    const p = run().finally(() => this.inflight.delete(project.id));
    this.inflight.set(project.id, p);
    return p;
  }

  /** Process at most one task. Returns what happened. */
  async tick(): Promise<TickResult> {
    const settings = await this.settingsStore.load();
    if (!settings.runner.enabled) return { kind: "disabled" };

    await this.syncAutoPlans();
    const next = await this.selectNext();
    if (!next) return { kind: "idle" };
    return this.start(next);
  }

  /**
   * Start tasks until the concurrency limit is reached or nothing more is selectable.
   * Returns the promises of the tasks started.
   */
  private async fill(concurrency: number): Promise<Promise<TickResult>[]> {
    const started: Promise<TickResult>[] = [];
    await this.syncAutoPlans();
    while (this.inflight.size < concurrency) {
      const next = await this.selectNext();
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
        results.push(settings.runner.enabled ? { kind: "idle" } : { kind: "disabled" });
        return results;
      }
      await Promise.race(this.inflight.values());
    }
  }

  /** Long-running loop. Honors cooperative stop and the enabled flag. */
  async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    this.stopRequested = false;
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
