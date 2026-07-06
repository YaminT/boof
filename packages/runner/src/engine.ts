import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendVersion,
  parseGoal,
  serializeGoal,
  SettingsStore,
  TaskStore,
  workingAreaDir,
  type Settings,
  type Task,
} from "@boof-runner/shared";
import { Pipeline, type PipelineOutcome } from "./pipeline.js";
import { ToolRegistry } from "./tools/registry.js";
import { pruneStaleWorktrees } from "./worktree.js";

export interface EngineOptions {
  root: string;
  pollIntervalMs?: number;
  registry?: ToolRegistry;
}

export type TickResult =
  | { kind: "ran"; outcome: PipelineOutcome }
  | { kind: "idle" }
  | { kind: "disabled" }
  | { kind: "blocked" };

/**
 * Background runner. Polls pending/, selects one task by priority, and drives
 * it through the pipeline. Cooperative on/off is checked at the task boundary
 * so the in-flight task finishes gracefully before the loop stops selecting
 * new work (runner-pipeline spec).
 */
export class RunnerEngine {
  readonly root: string;
  readonly store: TaskStore;
  readonly settingsStore: SettingsStore;
  readonly registry: ToolRegistry;
  private readonly pollIntervalMs: number;
  private looping = false;
  private stopRequested = false;

  constructor(opts: EngineOptions) {
    this.root = opts.root;
    this.store = new TaskStore(opts.root);
    this.settingsStore = new SettingsStore(opts.root);
    this.registry = opts.registry ?? new ToolRegistry();
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
  }

  /** Select the highest-priority eligible pending task, or null. */
  async selectNext(): Promise<Task | null> {
    const all = await this.store.list();
    const eligible = all
      .filter((t) => t.frontmatter.status === "pending" && !t.frontmatter.skip)
      .sort((a, b) => {
        if (b.frontmatter.priority !== a.frontmatter.priority) {
          return b.frontmatter.priority - a.frontmatter.priority; // higher first
        }
        return a.frontmatter.updated.localeCompare(b.frontmatter.updated); // older first
      });
    return eligible[0] ?? null;
  }

  /**
   * Block-hours placeholder (settings spec): empty list means never idle. Real
   * time-window evaluation will be added in a later iteration.
   */
  private isBlocked(settings: Settings): boolean {
    return settings.blockHours.length > 0 && false;
  }

  /** Transition pending → running and scaffold the working area. */
  private async startTask(id: string): Promise<Task> {
    const task = await this.store.transition(id, "running");
    const area = workingAreaDir(this.root, id);
    await mkdir(join(area, "reports"), { recursive: true });
    await writeFile(join(area, "log.txt"), "", { flag: "a" });
    await writeFile(join(area, "plan.md"), "", { flag: "a" });
    return task;
  }

  private async finalize(outcome: PipelineOutcome): Promise<void> {
    const id = outcome.task.frontmatter.id;
    if (outcome.kind === "done") {
      // Count this completed run. If more runs were requested, re-queue the
      // task to pending for its next iteration; otherwise finish (runs feature).
      const completed = outcome.task.frontmatter.completedRuns + 1;
      const runs = outcome.task.frontmatter.runs;
      const next = completed < runs ? "pending" : "done";
      await this.store.transition(id, next, (t) => {
        t.frontmatter.completedRuns = completed;
      });
      // On final completion of a scanned unit, bump its goal.boof.xml status.
      if (next === "done" && outcome.task.frontmatter.boofGoal) {
        await this.bumpGoalFile(outcome.task).catch(() => {});
      }
    } else if (outcome.kind === "failed") {
      await this.store.transition(id, "failed");
    } else {
      // Parked: record questions, set questions=pending, move to actions/.
      await this.store.transition(id, "action", (t) => {
        t.frontmatter.questions = "pending";
        t.body.questions = outcome.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
      });
    }
  }

  /**
   * Append a version to a scanned unit's goal.boof.xml, bumping its status
   * (goal-ingestion write-back). The path is relative to workingDirectory (the
   * scanned repo). Best-effort: failures are swallowed by the caller so a
   * successful task is never marked failed just because status write-back broke.
   */
  private async bumpGoalFile(task: Task): Promise<void> {
    const ref = task.frontmatter.boofGoal;
    if (!ref) return;
    const { workingDirectory } = await this.settingsStore.load();
    const goalPath = join(workingDirectory, ref.path);
    const goal = parseGoal(await readFile(goalPath, "utf8"));
    const bumped = appendVersion(
      goal,
      ref.bumpTo,
      `boof-runner completed task ${task.frontmatter.id}.`,
    );
    await writeFile(goalPath, serializeGoal(bumped), "utf8");
  }

  /** Process at most one task. Returns what happened. */
  async tick(): Promise<TickResult> {
    const settings = await this.settingsStore.load();
    if (!settings.runner.enabled) return { kind: "disabled" };
    if (this.isBlocked(settings)) return { kind: "blocked" };

    const next = await this.selectNext();
    if (!next) return { kind: "idle" };

    await this.startTask(next.frontmatter.id);
    const running = await this.store.get(next.frontmatter.id);
    const pipeline = new Pipeline({
      root: this.root,
      store: this.store,
      registry: this.registry,
      settings,
    });
    const outcome = await pipeline.run(running!);
    await this.finalize(outcome);
    return { kind: "ran", outcome };
  }

  /** Drain the queue until idle/disabled/blocked (used by tests and the loop). */
  async runUntilIdle(maxTasks = 1000): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (let i = 0; i < maxTasks; i += 1) {
      const r = await this.tick();
      results.push(r);
      if (r.kind !== "ran") break;
    }
    return results;
  }

  /** Long-running loop. Honors cooperative stop and the enabled flag. */
  async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    this.stopRequested = false;
    await pruneStaleWorktrees((await this.settingsStore.load()).workingDirectory).catch(() => {});
    try {
      while (!this.stopRequested) {
        const r = await this.tick();
        if (r.kind !== "ran") await this.sleep(this.pollIntervalMs);
      }
    } finally {
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
