/**
 * Plan sync (plan model, sections 4 and 5): materialise the goals of an active plan into tasks
 * and keep those tasks in line with the goals when a goal changes. Sync is idempotent: a second
 * run without changes writes nothing.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execCommand } from "./exec.js";
import { createIntegrationBranch, isAncestor } from "./plan-base.js";
import {
  appendEvent,
  AuthStore,
  diffGoalContent,
  isKebabId,
  newTask,
  nowIso,
  PlanStore,
  renderChanges,
  renderGoalContent,
  securitySettings,
  TaskStore,
  taskControlDir,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  uniqueKebabId,
  unifiedDiff,
  withGoalStatus,
  withFileLock,
  workingAreaDir,
  PlanVersionConflict,
  type Goal,
  type GoalSynced,
  type GoalTaskRef,
  type Plan,
  type Project,
  type Settings,
  type Status,
  type Task,
  type TaskOrigin,
  type TaskTools,
} from "@boof-runner/shared";

/** Sync was asked for a plan that is not `active`. */
export class PlanNotActiveError extends Error {
  constructor(
    public readonly planId: string,
    public readonly status: Plan["status"],
  ) {
    super(`Plan ${planId} is ${status}, not active; activate it before syncing`);
    this.name = "PlanNotActiveError";
  }
}

export interface SyncOptions {
  /** The project directory (`projects/<pid>`): the root of its TaskStore and PlanStore. */
  projectDir: string;
  project: Project;
  planId: string;
  /** Compute and report, write nothing. */
  dryRun?: boolean;
  /** A removed goal's running task is asked to stop (default: it is left running). */
  stopRunning?: boolean;
  /** Per-task tool override for the tasks created. */
  tools?: TaskTools;
  /** Status of the tasks created (default `pending`; `draft` for plans of review-trust clients). */
  createStatus?: "pending" | "draft";
  /**
   * Also create tasks for goals whose dependencies are not done yet, as skipped `blocked`
   * tasks that unskip when the dependencies finish. `scan` uses this to keep one task per unit.
   */
  includeBlocked?: boolean;
  /** The actor, recorded on the plan's events (default `runner`). */
  by?: string;
}

export interface SyncCreated {
  goalId: string;
  taskId: string;
  revision: number;
  /** True for the follow-up task of a goal whose spec changed after it was done. */
  followUp: boolean;
  status: Status;
  skip: boolean;
}
export interface SyncUpdated {
  goalId: string;
  taskId: string;
  action: "rewritten" | "appended" | "injected" | "unskipped" | "blocked";
  revision: number;
}
export interface SyncSkipped {
  goalId: string;
  taskId?: string;
  reason: "blocked";
}
export interface SyncArchived {
  goalId: string;
  taskId: string;
  action: "archived" | "stop-requested";
  reason: "goal-removed";
}

export interface SyncResult {
  planId: string;
  dryRun: boolean;
  created: SyncCreated[];
  updated: SyncUpdated[];
  skipped: SyncSkipped[];
  archived: SyncArchived[];
  /** The plan after the sync (goal `taskId`, `synced` and reopened statuses). */
  plan: Plan;
}

const LIVE: ReadonlySet<Status> = new Set([
  "draft",
  "pending",
  "running",
  "action",
  "failed",
  "stopped",
]);
const BLOCKED_LABEL = "blocked";

function addLabel(task: Task, label: string): boolean {
  if (task.frontmatter.labels.includes(label)) return false;
  task.frontmatter.labels = [...task.frontmatter.labels, label];
  return true;
}

function removeLabel(task: Task, label: string): boolean {
  if (!task.frontmatter.labels.includes(label)) return false;
  task.frontmatter.labels = task.frontmatter.labels.filter((l) => l !== label);
  return true;
}

/** The git branch boof-runner gives a task. */
export function taskBranch(taskId: string): string {
  return `boof-runner/${taskId}`;
}

function taskRef(t: Task): GoalTaskRef {
  return {
    taskId: t.frontmatter.id,
    revision: t.frontmatter.planRef!.revision,
    status: t.frontmatter.status,
    branch: taskBranch(t.frontmatter.id),
  };
}

/**
 * `goal.tasks` brought in line with the task files: known entries take the task's status, tasks
 * of the goal that are not listed yet (plans made before the list existed) are appended.
 */
function refreshTaskRefs(g: Goal, goalTasks: Task[]): GoalTaskRef[] {
  const byId = new Map(goalTasks.map((t) => [t.frontmatter.id, t]));
  const refs = g.tasks.map((r) => {
    const t = byId.get(r.taskId);
    return t && t.frontmatter.status !== r.status ? { ...r, status: t.frontmatter.status } : r;
  });
  const known = new Set(refs.map((r) => r.taskId));
  const extra = goalTasks
    .filter((t) => !known.has(t.frontmatter.id) && t.frontmatter.status !== "archived")
    .sort((a, b) => a.frontmatter.created.localeCompare(b.frontmatter.created))
    .map(taskRef);
  return extra.length > 0 ? [...refs, ...extra] : refs;
}

/**
 * The branch of the goal's latest finished task when it still exists in the repository: a
 * follow-up task starts from it so revision N builds on revision N-1.
 */
async function previousTaskBase(repoRoot: string, goalTasks: Task[]): Promise<string | undefined> {
  const done = goalTasks
    .filter((t) => t.frontmatter.status === "done")
    .sort(
      (a, b) =>
        b.frontmatter.planRef!.revision - a.frontmatter.planRef!.revision ||
        b.frontmatter.created.localeCompare(a.frontmatter.created),
    );
  for (const t of done) {
    const branch = taskBranch(t.frontmatter.id);
    try {
      const res = await execCommand(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: repoRoot, timeoutMs: 15000 },
      );
      if (res.code === 0 && res.stdout.trim()) return branch;
    } catch {
      /* not a repository or git missing: fall back to the default base */
    }
  }
  return undefined;
}

function snapshotOf(g: Goal): GoalSynced {
  return {
    revision: g.revision,
    spec: g.spec,
    dependsOn: g.dependsOn,
    ...(g.model ? { model: g.model } : {}),
  };
}

// --- Prompts ---

/**
 * The developer prompt of a goal. Same text as `buildUnitPrompt` for a scanned unit (the goal
 * spec is the whole specification, TDD, do not edit the plan files), plus a trailing `## Plan`
 * section naming the plan, goal and revision. Goals without a `path` have no goal file lines.
 */
export function buildGoalPrompt(goal: Goal, planId: string, repoRoot: string): string {
  const t = goal.spec.tests;
  const dos = goal.spec.rules.do.map((d) => `- ${d}`).join("\n") || "- (none specified)";
  const donts = goal.spec.rules.dont.map((d) => `- ${d}`).join("\n");
  const where = goal.path
    ? `Goal file: ${join(repoRoot, goal.path, "goal.boof.xml")}\nUnit directory: ${join(repoRoot, goal.path)}\n`
    : "";
  const parts = [
    `# Implement boof unit: ${goal.title}`,
    "You are implementing a single unit of a boof-seeded project. Its goal.boof.xml " +
      "is the complete specification — implement the unit strictly from that file; you " +
      "need nothing outside it and this unit's directory.",
    `${where}Current status: ${goal.status}`,
    `## Goal\n${goal.spec.goal}`,
    `## Stack\n${goal.spec.stack}`,
    `## Rules — Do\n${dos}`,
    donts ? `## Rules — Don't\n${donts}` : "",
    `## Tests (${t.strategy})\n- Technology: ${t.technology}\n- Run: ${t.run}` +
      (t.coverage ? `\n- Coverage: ${t.coverage}` : ""),
    "## How to work\n" +
      (/^(none|n\/a|-)$/i.test(t.run.trim())
        ? `- Follow the test strategy (${t.strategy}). There is no automated test command: check your result against the goal and the rules above.\n`
        : `- Follow the test strategy: write a failing test first, then implement until \`${t.run}\` is green.\n`) +
      "- Keep changes within this unit's scope/directory unless the goal explicitly requires otherwise.\n" +
      "- Do NOT edit goal.boof.xml or plan.boof.xml — boof-runner records the unit's status when the task completes.",
    `## Plan\n- Plan: ${planId}\n- Goal: ${goal.id}\n- Revision: ${goal.revision}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Prompt of the follow-up task for a goal whose spec changed after it was done. */
export function buildFollowUpPrompt(
  goal: Goal,
  planId: string,
  repoRoot: string,
  previous: GoalSynced | undefined,
  doneRevision: number,
): string {
  const base = buildGoalPrompt(goal, planId, repoRoot);
  const now = { spec: goal.spec, dependsOn: goal.dependsOn, model: goal.model };
  if (!previous) {
    return (
      `${base}\n\n## Spec change\nThis goal was already implemented at revision ${doneRevision}; ` +
      `its spec is now revision ${goal.revision} (the previous spec was not recorded). ` +
      "Compare the existing code with the spec above and update it so the spec holds."
    );
  }
  const before = { spec: previous.spec, dependsOn: previous.dependsOn, model: previous.model };
  return [
    base,
    `## Spec change\nThis goal was already implemented at revision ${previous.revision}; ` +
      `its spec is now revision ${goal.revision}. Update the existing implementation so the new spec holds; ` +
      "do not redo work that is still correct.",
    `### Changes\n${renderChanges(diffGoalContent(before, now))}`,
    `### Previous spec (revision ${previous.revision})\n\`\`\`\n${renderGoalContent(before)}\n\`\`\``,
    `### New spec (revision ${goal.revision})\n\`\`\`\n${renderGoalContent(now)}\n\`\`\``,
    `### Diff\n\`\`\`diff\n${unifiedDiff(renderGoalContent(before), renderGoalContent(now))}\n\`\`\``,
  ].join("\n\n");
}

/** The `## Dependencies` section of a prompt: dependency branches the agent merges itself. */
export function dependenciesSection(base: string | undefined, branches: string[]): string {
  return [
    "## Dependencies",
    `The work of goals this goal depends on is on other branches${base ? ` than your base (${base})` : ""}. ` +
      "Before you start, merge each branch below into your task branch with `git merge <branch>` " +
      "and resolve conflicts:",
    ...branches.map((b) => `- ${b}`),
  ].join("\n");
}

// --- Trust ---

/**
 * Status for tasks that sync creates for `plan`: `pending` when a trusted or local principal
 * approved the active plan (`approvedBy`: the human saw the content), `draft` when the plan
 * was created by a review-trust client (or one that no longer exists) and
 * `security.externalTasksRequireApproval` is on, so a human approves each task; `pending`
 * otherwise.
 */
export async function taskStatusForPlan(
  root: string,
  plan: Plan,
  settings: Settings,
): Promise<"pending" | "draft"> {
  const clientId = plan.source.client;
  if (!clientId) return "pending";
  if (plan.status === "active" && plan.approvedBy) return "pending";
  if (!securitySettings(settings).externalTasksRequireApproval) return "pending";
  try {
    const client = await new AuthStore(root).get(clientId);
    return client && client.trust === "trusted" ? "pending" : "draft";
  } catch {
    return "draft";
  }
}

// --- Removed goals ---

/**
 * Tasks of goals that are no longer in the plan: pending/draft tasks are archived with the
 * label `goal-removed`; a running task gets a stop request only with `stopRunning`; done
 * tasks stay. Returns what was (or, for a dry run, would be) done.
 */
export async function archiveRemovedGoalTasks(opts: {
  projectDir: string;
  plan: Plan;
  tasks?: Task[];
  stopRunning?: boolean;
  dryRun?: boolean;
}): Promise<SyncArchived[]> {
  const store = new TaskStore(opts.projectDir);
  const goalIds = new Set(opts.plan.goals.map((g) => g.id));
  const out: SyncArchived[] = [];
  for (const task of opts.tasks ?? (await store.list())) {
    const ref = task.frontmatter.planRef;
    if (!ref || ref.planId !== opts.plan.id || goalIds.has(ref.goalId)) continue;
    const id = task.frontmatter.id;
    const status = task.frontmatter.status;
    if (status === "pending" || status === "draft") {
      if (!opts.dryRun) {
        await store.transition(id, "archived", (t) => {
          addLabel(t, "goal-removed");
          t.body.log = [
            t.body.log,
            `## Plan change\nGoal ${ref.goalId} was removed from plan ${ref.planId}.`,
          ]
            .filter(Boolean)
            .join("\n\n");
        });
      }
      out.push({ goalId: ref.goalId, taskId: id, action: "archived", reason: "goal-removed" });
    } else if (status === "running" && opts.stopRunning) {
      if (!opts.dryRun) {
        await mkdir(taskControlDir(opts.projectDir, id), { recursive: true });
        await writeFile(taskStopRequestPath(opts.projectDir, id), nowIso() + "\n", "utf8");
        await appendFile(
          join(workingAreaDir(opts.projectDir, id), "log.txt"),
          `\n\n### Stop requested\nGoal ${ref.goalId} was removed from plan ${ref.planId}.\n`,
          "utf8",
        ).catch(() => {});
        const fresh = await store.get(id);
        if (fresh && addLabel(fresh, "goal-removed")) await store.save(fresh);
      }
      out.push({
        goalId: ref.goalId,
        taskId: id,
        action: "stop-requested",
        reason: "goal-removed",
      });
    }
  }
  return out;
}

// --- Sync ---

/** Revision at which a done goal was last completed (history), else its current revision. */
function doneRevisionOf(g: Goal): number {
  for (let i = g.history.length - 1; i >= 0; i -= 1) {
    if (g.history[i]!.status === "done") return g.history[i]!.revision;
  }
  return g.revision;
}

function originOf(plan: Plan): TaskOrigin | undefined {
  const client = plan.source.client;
  if (!client || !isKebabId(client)) return undefined;
  return { kind: plan.source.kind === "mcp" ? "mcp" : "api", client };
}

async function syncOnce(
  plan: Plan,
  opts: SyncOptions,
): Promise<{ result: Omit<SyncResult, "plan">; next: Plan }> {
  const store = new TaskStore(opts.projectDir);
  const dry = opts.dryRun === true;
  const repoRoot = opts.project.workingDirectory;
  const allTasks = await store.list();
  const taken = new Set(allTasks.map((t) => t.frontmatter.id));
  const mine = allTasks.filter((t) => t.frontmatter.planRef?.planId === plan.id);
  const createStatus = opts.createStatus ?? "pending";
  const now = nowIso();

  const result: Omit<SyncResult, "plan"> = {
    planId: plan.id,
    dryRun: dry,
    created: [],
    updated: [],
    skipped: [],
    archived: [],
  };

  const goals: Goal[] = plan.goals.map((g) => ({ ...g }));
  const byId = new Map(goals.map((g) => [g.id, g]));

  // Pass 1: a done goal whose spec moved on since it was completed goes back to `develop`.
  const reopen = new Set<string>();
  for (const g of goals) {
    if (g.status === "done" && doneRevisionOf(g) < g.revision) {
      reopen.add(g.id);
    }
  }
  const isDone = (g: Goal) => g.status === "done" && !reopen.has(g.id);
  const open = goals.filter((g) => !isDone(g));
  const priorityOf = (g: Goal) => (open.length - open.indexOf(g)) * 10;

  /** Finished branch of each goal `g` depends on, in dependsOn order, when it exists in the repo. */
  const dependencyBranches = async (g: Goal): Promise<{ goalId: string; branch: string }[]> => {
    const out: { goalId: string; branch: string }[] = [];
    for (const d of g.dependsOn) {
      const branch = await previousTaskBase(
        repoRoot,
        mine.filter((t) => t.frontmatter.planRef!.goalId === d),
      );
      if (branch && !out.some((o) => o.branch === branch)) out.push({ goalId: d, branch });
    }
    return out;
  };

  /**
   * Where the task of goal `g` starts: the goal's own previous branch (follow-up), else the
   * dependencies' branches (one: that branch; several: an integration branch, or the first
   * when they conflict), else the project default base. `mergeFirst` lists the dependency
   * branches the agent must merge itself; `log` says what was chosen and why.
   */
  const chooseBase = async (
    g: Goal,
    taskId: string,
    ownBase: string | undefined,
  ): Promise<{ base: string | undefined; mergeFirst: string[]; log: string }> => {
    const deps = await dependencyBranches(g);
    if (ownBase) {
      const missing: string[] = [];
      for (const d of deps)
        if (!(await isAncestor(repoRoot, d.branch, ownBase))) missing.push(d.branch);
      return {
        base: ownBase,
        mergeFirst: missing,
        log:
          `Base: ${ownBase} (the finished branch of this goal's previous task).` +
          (missing.length > 0
            ? ` Dependency branches not contained in it, listed in the prompt to merge: ${missing.join(", ")}.`
            : ""),
      };
    }
    const names = (list: typeof deps) =>
      list.map((d) => `${d.branch} (goal ${d.goalId})`).join(", ");
    if (deps.length === 1) {
      return {
        base: deps[0]!.branch,
        mergeFirst: [],
        log: `Base: ${deps[0]!.branch} (the finished branch of goal ${deps[0]!.goalId}, which this goal depends on).`,
      };
    }
    if (deps.length > 1) {
      const integration = `${taskBranch(taskId)}--base`;
      if (dry) {
        return {
          base: integration,
          mergeFirst: [],
          log: `Base: ${integration} (would merge ${names(deps)}).`,
        };
      }
      const merged = await createIntegrationBranch(
        repoRoot,
        integration,
        deps.map((d) => d.branch),
      );
      if (merged.ok) {
        return {
          base: integration,
          mergeFirst: [],
          log: `Base: ${integration} (merge of ${names(deps)}).`,
        };
      }
      return {
        base: deps[0]!.branch,
        mergeFirst: deps.slice(1).map((d) => d.branch),
        log:
          `Base: ${deps[0]!.branch} (first dependency; no integration branch because ${merged.reason}). ` +
          `Other dependency branches to merge first: ${deps
            .slice(1)
            .map((d) => d.branch)
            .join(", ")}.`,
      };
    }
    const fallback = opts.project.defaultBase ?? undefined;
    return {
      base: fallback,
      mergeFirst: [],
      log: fallback
        ? `Base: ${fallback} (the project default base; no finished dependency branch found).`
        : "Base: HEAD of the project repository (no finished dependency branch and no default base).",
    };
  };

  const create = async (
    g: Goal,
    followUp: boolean,
    skip: boolean,
    doneRev: number,
    ownBase: string | undefined,
  ): Promise<Task | null> => {
    const id = uniqueKebabId(
      followUp ? `update ${g.id} to revision ${g.revision}` : `boof ${g.id}`,
      taken,
    );
    taken.add(id);
    const chosen = await chooseBase(g, id, ownBase);
    const base = chosen.base;
    const basePrompt = followUp
      ? buildFollowUpPrompt(g, plan.id, repoRoot, g.synced, doneRev)
      : buildGoalPrompt(g, plan.id, repoRoot);
    const prompt =
      chosen.mergeFirst.length > 0
        ? `${basePrompt}\n\n${dependenciesSection(chosen.base, chosen.mergeFirst)}`
        : basePrompt;
    const labels = [
      ...(plan.source.kind === "repo-import" ? ["boof-scan", `boof-status:${g.status}`] : []),
      `plan:${plan.id}`,
      `goal:${g.id}`,
      ...(skip ? [BLOCKED_LABEL] : []),
      ...(createStatus === "draft" && plan.source.client ? [`external:${plan.source.client}`] : []),
    ];
    const origin = originOf(plan);
    const task = newTask(
      {
        id,
        title: followUp ? `Update ${g.title} to revision ${g.revision}` : `boof: ${g.title}`,
        status: createStatus,
        priority: priorityOf(g),
        skip,
        labels,
        command: null,
        attachments: [],
        questions: "none",
        runs: 1,
        completedRuns: 0,
        ...(base ? { base } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        planRef: { planId: plan.id, goalId: g.id, revision: g.revision },
        promptSource: "plan",
        ...(origin ? { origin } : {}),
        created: "",
        updated: "",
      },
      prompt,
    );
    task.body.log = `## Base\n${chosen.log}`;
    result.created.push({
      goalId: g.id,
      taskId: id,
      revision: g.revision,
      followUp,
      status: createStatus,
      skip,
    });
    if (!dry) await store.create(task, { by: opts.by });
    return task;
  };

  /** Apply the change matrix to the live task `task` of goal `g`. */
  const applyChange = async (g: Goal, task: Task): Promise<void> => {
    const ref = task.frontmatter.planRef!;
    const before = g.synced
      ? { spec: g.synced.spec, dependsOn: g.synced.dependsOn, model: g.synced.model }
      : undefined;
    const current = { spec: g.spec, dependsOn: g.dependsOn, model: g.model };
    const summary = before
      ? renderChanges(diffGoalContent(before, current))
      : `(the previous spec was not recorded)\n${renderGoalContent(current)}`;
    const id = task.frontmatter.id;

    if (task.frontmatter.status === "running") {
      const marker = `spec changed to revision ${g.revision}:`;
      const existing = await readFile(taskPromptInjectionsPath(opts.projectDir, id), "utf8").catch(
        () => "",
      );
      if (existing.includes(marker)) return;
      if (!dry) {
        const text = `The goal ${marker}\n${summary}\nAdjust the remaining work accordingly.`;
        await mkdir(taskControlDir(opts.projectDir, id), { recursive: true });
        await appendFile(
          taskPromptInjectionsPath(opts.projectDir, id),
          `\n\n## ${now}\n${text}\n`,
          "utf8",
        );
        await store.appendInjected(id, text, "plan sync").catch(() => {});
        await appendFile(
          join(workingAreaDir(opts.projectDir, id), "log.txt"),
          `\n\n### Injected prompt\n${text}\n`,
          "utf8",
        ).catch(() => {});
        // Best effort: the pipeline also saves this file, so the label can be overwritten.
        const fresh = await store.get(id);
        if (fresh && fresh.frontmatter.status === "running" && addLabel(fresh, "stale-revision")) {
          await store.save(fresh);
        }
      }
      result.updated.push({ goalId: g.id, taskId: id, action: "injected", revision: g.revision });
      return;
    }

    // draft, pending, action (questions kept), failed and stopped (both stay put for a retry)
    const manual = task.frontmatter.promptSource === "manual";
    const note = `## Plan change\nGoal ${g.id} is now at revision ${g.revision} (was ${ref.revision}).\n${summary}`;
    if (!dry) {
      if (manual) {
        task.body.prompt = `${task.body.prompt}\n\n## Plan change (revision ${g.revision})\nThe goal spec changed after this prompt was edited by hand; apply these changes too:\n${summary}`;
        addLabel(task, "needs-review");
      } else {
        task.body.prompt = buildGoalPrompt(g, plan.id, repoRoot);
        task.frontmatter.promptSource = "plan";
      }
      task.frontmatter.planRef = { ...ref, revision: g.revision };
      task.body.log = [task.body.log, note].filter(Boolean).join("\n\n");
      await store.save(task);
    }
    g.synced = snapshotOf(g);
    result.updated.push({
      goalId: g.id,
      taskId: id,
      action: manual ? "appended" : "rewritten",
      revision: g.revision,
    });
  };

  // Pass 2: goals in order.
  for (const g of goals) {
    g.tasks = refreshTaskRefs(
      g,
      mine.filter((t) => t.frontmatter.planRef!.goalId === g.id),
    );
    const reopened = reopen.has(g.id);
    if (reopened) {
      Object.assign(g, withGoalStatus(g, "develop", `spec changed to revision ${g.revision}`, now));
    } else if (g.status === "done") {
      g.taskId = null;
      continue;
    }

    const goalTasks = mine.filter((t) => t.frontmatter.planRef!.goalId === g.id);
    const live = goalTasks
      .filter((t) => LIVE.has(t.frontmatter.status))
      .sort(
        (a, b) =>
          b.frontmatter.planRef!.revision - a.frontmatter.planRef!.revision ||
          b.frontmatter.created.localeCompare(a.frontmatter.created),
      );
    const settled = goalTasks.filter(
      (t) =>
        (t.frontmatter.status === "done" || t.frontmatter.status === "archived") &&
        !t.frontmatter.labels.includes("goal-removed"),
    );
    const settledRevision = settled.reduce(
      (m, t) => Math.max(m, t.frontmatter.planRef!.revision),
      0,
    );
    const blocked = g.dependsOn.some((d) => !(byId.get(d) && isDone(byId.get(d)!)));

    const current = live[0];
    if (current && current.frontmatter.planRef!.revision < g.revision) {
      await applyChange(g, current);
    }

    if (current) {
      if (blocked) {
        result.skipped.push({ goalId: g.id, taskId: current.frontmatter.id, reason: "blocked" });
        if (current.frontmatter.status === "pending" && !current.frontmatter.skip) {
          if (!dry) {
            const fresh = (await store.get(current.frontmatter.id)) ?? current;
            fresh.frontmatter.skip = true;
            addLabel(fresh, BLOCKED_LABEL);
            await store.save(fresh);
          }
          result.updated.push({
            goalId: g.id,
            taskId: current.frontmatter.id,
            action: "blocked",
            revision: g.revision,
          });
        }
      } else if (
        current.frontmatter.status === "pending" &&
        current.frontmatter.labels.includes(BLOCKED_LABEL)
      ) {
        if (!dry) {
          const fresh = (await store.get(current.frontmatter.id)) ?? current;
          fresh.frontmatter.skip = false;
          removeLabel(fresh, BLOCKED_LABEL);
          await store.save(fresh);
        }
        result.updated.push({
          goalId: g.id,
          taskId: current.frontmatter.id,
          action: "unskipped",
          revision: g.revision,
        });
      }
      g.taskId = current.frontmatter.id;
      continue;
    }

    // No live task: create one unless this revision was already worked on or archived.
    if (settledRevision >= g.revision) {
      g.taskId = null;
      continue;
    }
    if (blocked && !opts.includeBlocked) {
      result.skipped.push({ goalId: g.id, reason: "blocked" });
      g.taskId = null;
      continue;
    }
    const followUp = reopened || settled.some((t) => t.frontmatter.status === "done");
    const ownBase = await previousTaskBase(repoRoot, settled);
    const created = await create(
      g,
      followUp,
      blocked,
      settledRevision || doneRevisionOf(g),
      ownBase,
    );
    g.taskId = created?.frontmatter.id ?? null;
    if (created) g.tasks = [...g.tasks, taskRef(created)];
    g.synced = snapshotOf(g);
    if (blocked)
      result.skipped.push({ goalId: g.id, taskId: g.taskId ?? undefined, reason: "blocked" });
  }

  result.archived = await archiveRemovedGoalTasks({
    projectDir: opts.projectDir,
    plan,
    tasks: mine,
    stopRunning: opts.stopRunning,
    dryRun: dry,
  });

  return { result, next: { ...plan, goals } };
}

/**
 * Sync one plan to its project's tasks. Throws {@link PlanNotActiveError} unless the plan is
 * `active`. Tasks are written first, then the plan (goal `taskId`, `synced`, reopened goals);
 * when another writer changed the plan in between, the sync runs again on the new version
 * (it finds the tasks it already made).
 */
export async function syncPlan(opts: SyncOptions): Promise<SyncResult> {
  const result = await syncPlanInner(opts);
  const created = result.created.length;
  const updated = result.updated.length + result.archived.length;
  if (!result.dryRun && created + updated > 0) {
    await appendEvent(opts.projectDir, {
      type: "plan.synced",
      project: basename(opts.projectDir),
      plan: result.planId,
      created,
      updated,
      by: opts.by ?? "runner",
    });
  }
  return result;
}

/** One sync at a time per plan, so a manual sync and the engine's autoSync cannot overlap. */
function syncPlanInner(opts: SyncOptions): Promise<SyncResult> {
  return withFileLock(`${opts.projectDir}#plan-sync:${opts.planId}`, () => syncPlanUnlocked(opts));
}

async function syncPlanUnlocked(opts: SyncOptions): Promise<SyncResult> {
  const plans = new PlanStore(opts.projectDir);
  for (let attempt = 0; ; attempt += 1) {
    const plan = await plans.require(opts.planId);
    if (plan.status !== "active") throw new PlanNotActiveError(plan.id, plan.status);
    const { result, next } = await syncOnce(plan, opts);
    if (opts.dryRun || JSON.stringify(next.goals) === JSON.stringify(plan.goals)) {
      return { ...result, plan: opts.dryRun ? next : plan };
    }
    try {
      return {
        ...result,
        plan: await plans.save(next, { expectedVersion: plan.version, by: opts.by }),
      };
    } catch (err) {
      if (!(err instanceof PlanVersionConflict) || attempt >= 3) throw err;
    }
  }
}
