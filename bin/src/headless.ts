/**
 * Headless drivers for the CLI: enqueue a task from a prompt and drive it (and
 * optionally the whole queue) through the pipeline without starting the web
 * server, plus scan mode that turns a repo's goal.boof.xml units into tasks.
 * Everything here is pure orchestration over the shared/runner packages so it
 * is unit-testable with the offline `mock` tool.
 */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  newTask,
  PlanStore,
  ProjectStore,
  SettingsStore,
  TaskStore,
  workingAreaDir,
  type BoofGoalRef,
  type Project,
  type Settings,
  type Status,
  type TaskTools,
  withApproval,
} from "@boof-runner/shared";
import {
  isGitRepo,
  RunnerEngine,
  ToolRegistry,
  importFromRepo,
  mergeImportedGoals,
  selectActionableUnits,
  syncPlan,
  type ScannedUnit,
  type TickResult,
} from "@boof-runner/runner";
import { scaffoldDataRoot } from "./scaffold.js";

/** Id of the plan `scan` keeps for a project. */
const SCAN_PLAN_ID = "repo";

/** Raw output sink (defaults to stdout). */
export type Out = (chunk: string) => void;
const stdoutWrite: Out = (c) => process.stdout.write(c);

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a per-task tool override (all roles → one tool) when requested. The
 * observer is overridden only when one is configured, so --tool never switches
 * a disabled observer on.
 */
export function toolOverride(
  registry: ToolRegistry,
  settings: Settings,
  tool?: string,
  model?: string,
): TaskTools | undefined {
  if (!tool) return undefined;
  const t = registry.get(tool);
  const m = model ?? t?.defaultModels[0] ?? "default";
  const a = { tool, model: m };
  return {
    planner: a,
    developer: a,
    reviewer: a,
    ...(settings.roles.observer ? { observer: a } : {}),
  };
}

/**
 * Run one engine tick while live-tailing the selected task's log.txt to `out`,
 * so progress streams to the terminal as the agents produce it.
 */
async function streamTick(engine: RunnerEngine, out: Out): Promise<TickResult> {
  const next = await engine.selectNext();
  if (!next) return engine.tick(); // idle/disabled/blocked — nothing to tail
  const id = next.task.frontmatter.id;
  const projectDir = engine.projects.dir(next.project.id);
  out(`\n▶ ${next.project.id}/${id} — ${next.task.frontmatter.title}\n`);
  const logPath = join(workingAreaDir(projectDir, id), "log.txt");
  let offset = 0;
  let stop = false;
  const flush = async () => {
    try {
      const buf = await readFile(logPath, "utf8");
      if (buf.length > offset) {
        out(buf.slice(offset));
        offset = buf.length;
      }
    } catch {
      /* working area not created yet, or removed on completion */
    }
  };
  const tail = (async () => {
    while (!stop) {
      await flush();
      await sleep(100);
    }
  })();
  const res = await engine.tick();
  stop = true;
  await tail;
  await flush();
  if (res.kind === "ran") out(`\n■ ${id}: ${res.outcome.kind}\n`);
  return res;
}

/** Which project a command acts on: an id, a repository directory, or the data root's default. */
export interface ProjectRef {
  /** Project id. */
  project?: string;
  /** Repository directory: the project with this realpath, registered on first use. */
  repo?: string;
}

/** Thrown for a bad project reference; the message is for the user. */
export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}

/**
 * Resolve the project for a headless command. `project` wins, then `repo` (realpath lookup;
 * an unknown repository is registered and its new id printed), then
 * `settings.defaultProject`. Never touches settings.json.
 */
export async function resolveProject(
  root: string,
  ref: ProjectRef,
  out: Out = stdoutWrite,
): Promise<Project> {
  const projects = new ProjectStore(root, { isGitRepo });
  let project: Project | null = null;
  if (ref.project) {
    project = await projects.get(ref.project);
    if (!project) throw new ProjectResolutionError(`Project not found: ${ref.project}`);
  } else if (ref.repo) {
    const dir = abs(ref.repo);
    project = await projects.findByDirectory(dir);
    if (!project) {
      try {
        project = await projects.create({ workingDirectory: dir, origin: { kind: "cli" } });
      } catch (err) {
        throw new ProjectResolutionError(err instanceof Error ? err.message : String(err));
      }
      out(`Registered project '${project.id}' for ${project.workingDirectory}\n`);
    }
  } else {
    const id = (await new SettingsStore(root).load()).defaultProject;
    if (!id) {
      throw new ProjectResolutionError(
        "No project: pass --project <id> or --repo <dir>, or set a default with `project add <dir> --default`.",
      );
    }
    project = await projects.get(id);
    if (!project) throw new ProjectResolutionError(`Default project not found: ${id}`);
  }
  if (project.archived) throw new ProjectResolutionError(`Project '${project.id}' is archived.`);
  if (!project.workingDirectory) {
    throw new ProjectResolutionError(
      `Project '${project.id}' has no working directory; set one with the UI or PUT /api/projects/${project.id}.`,
    );
  }
  return project;
}

/** Turn the runner on (the only global setting headless commands change), logging the change. */
async function ensureRunnerEnabled(root: string, out: Out): Promise<void> {
  const store = new SettingsStore(root);
  if ((await store.load()).runner.enabled) return;
  await store.update({ runner: { enabled: true } });
  out("Enabled the runner in settings.json (runner.enabled = true).\n");
}

export interface RunTaskOptions {
  root: string;
  prompt: string;
  title?: string;
  /** Project id the task is queued in. */
  project?: string;
  /** Repository the pipeline runs against (git repo → worktree isolation); registered if unknown. */
  repo?: string;
  /** Branch or commit the task's worktree starts from (frontmatter `base`). */
  base?: string;
  tool?: string;
  model?: string;
  runs?: number;
  registry?: ToolRegistry;
  out?: Out;
}

export interface RunResultSummary {
  id: string;
  projectId: string;
  status: Status;
  ok: boolean;
}

/**
 * Create a single high-priority task from `prompt`, enqueue it, and drive the
 * pipeline until that task reaches a terminal state. Returns ok=true only when
 * the task finished (`done`).
 */
export async function runTask(opts: RunTaskOptions): Promise<RunResultSummary> {
  const out = opts.out ?? stdoutWrite;
  await scaffoldDataRoot(opts.root);
  const project = await resolveProject(opts.root, opts, out);
  if (project.paused) {
    throw new ProjectResolutionError(`Project '${project.id}' is paused; resume it first.`);
  }
  const store = new TaskStore(new ProjectStore(opts.root).dir(project.id));
  const settings = await new SettingsStore(opts.root).load();
  await ensureRunnerEnabled(opts.root, out);

  const registry = opts.registry ?? new ToolRegistry();
  const title = opts.title ?? firstLine(opts.prompt);
  const tools = toolOverride(registry, settings, opts.tool, opts.model);
  const { frontmatter } = await store.createUnique(
    newTask(
      {
        id: "pending-id",
        title,
        status: "pending",
        priority: 1000, // ahead of any pre-existing queue so it runs first
        skip: false,
        labels: ["cli-run"],
        command: null,
        attachments: [],
        questions: "none",
        runs: Math.max(1, Math.floor(opts.runs ?? 1)),
        completedRuns: 0,
        ...(opts.base ? { base: opts.base } : {}),
        ...(tools ? { tools } : {}),
        created: "",
        updated: "",
      },
      opts.prompt,
    ),
  );
  const id = frontmatter.id;

  const engine = new RunnerEngine({ root: opts.root, registry, onlyProject: project.id });
  // Drive until our task leaves the active states. One tick fully runs the
  // highest-priority pending task (ours), so this normally loops once.
  for (;;) {
    const located = await store.locate(id);
    const status = located?.status;
    if (!status || ["done", "failed", "stopped", "action", "archived"].includes(status)) break;
    const res = await streamTick(engine, out);
    if (res.kind === "disabled" || res.kind === "blocked") break;
    if (res.kind === "idle") break;
  }

  const finalStatus = (await store.locate(id))?.status ?? "failed";
  const ok = finalStatus === "done";
  out(
    `\n${ok ? "[done]" : finalStatus === "stopped" ? "[stopped]" : "[not done]"} task ${project.id}/${id}: ${finalStatus}\n`,
  );
  return { id, projectId: project.id, status: finalStatus as Status, ok };
}

/** Drive the entire pending queue to completion (used after `scan`). */
export async function drainQueue(opts: {
  root: string;
  /** Only drain this project (default: every project). */
  project?: string;
  registry?: ToolRegistry;
  out?: Out;
}): Promise<{ ran: number; failed: number }> {
  const out = opts.out ?? stdoutWrite;
  await scaffoldDataRoot(opts.root);
  if (opts.project && !(await new ProjectStore(opts.root).get(opts.project))) {
    throw new ProjectResolutionError(`Project not found: ${opts.project}`);
  }
  await ensureRunnerEnabled(opts.root, out);
  const engine = new RunnerEngine({
    root: opts.root,
    registry: opts.registry ?? new ToolRegistry(),
    onlyProject: opts.project,
  });
  let ran = 0;
  let failed = 0;
  let stopped = 0;
  for (;;) {
    const res = await streamTick(engine, out);
    if (res.kind !== "ran") break;
    ran += 1;
    if (res.outcome.kind === "failed") failed += 1;
    if (res.outcome.kind === "stopped") stopped += 1;
  }
  out(
    `\nqueue drained: ${ran} task(s) ran, ${failed} failed` +
      `${stopped > 0 ? `, ${stopped} stopped` : ""}\n`,
  );
  // A stopped task did not finish: it counts against the exit code like a failure.
  return { ran, failed: failed + stopped };
}

export interface ScanOptions {
  root: string;
  repo: string;
  /** Project id the tasks go to; it must be the project of `repo`. Default: the project of `repo`, registered if needed. */
  project?: string;
  dryRun?: boolean;
  bumpTo?: BoofGoalRef["bumpTo"];
  tool?: string;
  model?: string;
  registry?: ToolRegistry;
  out?: Out;
}

export interface ScanSummary {
  created: string[];
  /** Project the tasks went to (absent for a dry run or when nothing was found). */
  projectId?: string;
  units: ScannedUnit[];
  dryRun: boolean;
}

/**
 * Scan `repo` for not-done goal.boof.xml units and create one pipeline task per
 * unit (dependency order → priority). With `dryRun`, only lists what it would
 * create. The tasks go to the project of `repo` (registered on first use), so the runner and
 * the status write-back both target the scanned repo. Global settings are not touched.
 */
export async function scanRepoToTasks(opts: ScanOptions): Promise<ScanSummary> {
  const out = opts.out ?? stdoutWrite;
  const repo = abs(opts.repo);
  const units = await selectActionableUnits(repo);

  if (units.length === 0) {
    out(`No actionable goal.boof.xml units found under ${repo} (nothing to do).\n`);
    return { created: [], units, dryRun: !!opts.dryRun };
  }

  out(`Found ${units.length} not-done unit(s) in ${repo}:\n`);
  for (const u of units) {
    out(`  - ${u.id}  [${u.status}${u.blocked ? ", blocked" : ""}]  ${u.goalPath}\n`);
  }

  if (opts.dryRun) {
    out(`\n(dry run — no tasks created)\n`);
    return { created: [], units, dryRun: true };
  }

  await scaffoldDataRoot(opts.root);
  const project = await resolveProject(
    opts.root,
    opts.project ? { project: opts.project } : { repo },
    out,
  );
  if ((await realpath(repo)) !== project.workingDirectory) {
    throw new ProjectResolutionError(
      `Project '${project.id}' works on ${project.workingDirectory}, not ${repo}; scan that directory or omit --project.`,
    );
  }
  const projectDir = new ProjectStore(opts.root).dir(project.id);
  const settings = await new SettingsStore(opts.root).load();

  const registry = opts.registry ?? new ToolRegistry();
  const tools = toolOverride(registry, settings, opts.tool, opts.model);
  const bumpTo = opts.bumpTo ?? "done";

  // scan = import the repo into the plan `repo` (merging into it on a re-scan), then sync it.
  // Blocked units get a skipped task too (as before, one task per not-done unit); sync unskips
  // them when their dependencies finish, and `autoSync` creates the tasks of later changes.
  const plans = new PlanStore(projectDir);
  const imported = await importFromRepo(project.workingDirectory);
  if (!(await plans.get(SCAN_PLAN_ID))) {
    await plans.create({
      id: SCAN_PLAN_ID,
      title: `boof scan of ${project.name}`,
      status: "active",
      // The CLI runs as the local owner, so the plan it activates is approved at once.
      approvedBy: { principalId: "local", at: new Date().toISOString(), version: 1 },
      autoSync: true,
      bumpTo,
      source: { kind: "repo-import", importedFrom: project.workingDirectory },
      goals: imported.goals,
    });
  } else {
    await plans.modify(SCAN_PLAN_ID, (p) =>
      // activating (or keeping active) as the local owner approves the plan, as the API does
      withApproval(
        p,
        {
          ...p,
          status: "active",
          bumpTo: opts.bumpTo ?? p.bumpTo,
          goals: mergeImportedGoals(p.goals, imported.goals).goals,
        },
        "local",
      ),
    );
  }
  const synced = await syncPlan({
    projectDir,
    project,
    planId: SCAN_PLAN_ID,
    includeBlocked: true,
    ...(tools ? { tools } : {}),
  });
  const created = synced.created.map((c) => c.taskId);

  out(
    `\nCreated ${created.length} task(s) in project '${project.id}'. Run them with:  boof-runner run --all --project ${project.id} -d ${opts.root}\n`,
  );
  return { created, units, dryRun: false, projectId: project.id };
}

function firstLine(s: string): string {
  const line =
    s
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "task";
  return line.length > 80 ? line.slice(0, 80) : line;
}
