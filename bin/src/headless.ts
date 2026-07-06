/**
 * Headless drivers for the CLI: enqueue a task from a prompt and drive it (and
 * optionally the whole queue) through the pipeline without starting the web
 * server, plus scan mode that turns a repo's goal.boof.xml units into tasks.
 * Everything here is pure orchestration over the shared/runner packages so it
 * is unit-testable with the offline `mock` tool.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  newTask,
  SettingsStore,
  TaskStore,
  uniqueKebabId,
  workingAreaDir,
  type BoofGoalRef,
  type Status,
  type TaskTools,
} from "@boof-runner/shared";
import {
  RunnerEngine,
  ToolRegistry,
  buildUnitPrompt,
  selectActionableUnits,
  type ScannedUnit,
  type TickResult,
} from "@boof-runner/runner";
import { scaffoldDataRoot } from "./scaffold.js";

/** Raw output sink (defaults to stdout). */
export type Out = (chunk: string) => void;
const stdoutWrite: Out = (c) => process.stdout.write(c);

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a per-task tool override (all three roles → one tool) when requested. */
function toolOverride(
  registry: ToolRegistry,
  tool?: string,
  model?: string,
): TaskTools | undefined {
  if (!tool) return undefined;
  const t = registry.get(tool);
  const m = model ?? t?.defaultModels[0] ?? "default";
  const a = { tool, model: m };
  return { planner: a, developer: a, reviewer: a };
}

/**
 * Run one engine tick while live-tailing the selected task's log.txt to `out`,
 * so progress streams to the terminal as the agents produce it.
 */
async function streamTick(engine: RunnerEngine, root: string, out: Out): Promise<TickResult> {
  const next = await engine.selectNext();
  if (!next) return engine.tick(); // idle/disabled/blocked — nothing to tail
  const id = next.frontmatter.id;
  out(`\n▶ ${id} — ${next.frontmatter.title}\n`);
  const logPath = join(workingAreaDir(root, id), "log.txt");
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

export interface RunTaskOptions {
  root: string;
  prompt: string;
  title?: string;
  /** Working directory the pipeline runs against (git repo → worktree isolation). */
  repo?: string;
  tool?: string;
  model?: string;
  runs?: number;
  registry?: ToolRegistry;
  out?: Out;
}

export interface RunResultSummary {
  id: string;
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
  const store = new TaskStore(opts.root);
  const settingsStore = new SettingsStore(opts.root);
  const settings = await settingsStore.load();
  await settingsStore.save({
    ...settings,
    runner: { enabled: true },
    workingDirectory: opts.repo ? abs(opts.repo) : settings.workingDirectory,
  });

  const registry = opts.registry ?? new ToolRegistry();
  const existing = (await store.list()).map((t) => t.frontmatter.id);
  const title = opts.title ?? firstLine(opts.prompt);
  const id = uniqueKebabId(title, existing);
  const tools = toolOverride(registry, opts.tool, opts.model);
  await store.create(
    newTask(
      {
        id,
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
        ...(tools ? { tools } : {}),
        created: "",
        updated: "",
      },
      opts.prompt,
    ),
  );

  const engine = new RunnerEngine({ root: opts.root, registry });
  // Drive until our task leaves the active states. One tick fully runs the
  // highest-priority pending task (ours), so this normally loops once.
  for (;;) {
    const located = await store.locate(id);
    const status = located?.status;
    if (!status || ["done", "failed", "action", "archived"].includes(status)) break;
    const res = await streamTick(engine, opts.root, out);
    if (res.kind === "disabled" || res.kind === "blocked") break;
    if (res.kind === "idle") break;
  }

  const finalStatus = (await store.locate(id))?.status ?? "failed";
  const ok = finalStatus === "done";
  out(`\n${ok ? "[done]" : "[not done]"} task ${id}: ${finalStatus}\n`);
  return { id, status: finalStatus as Status, ok };
}

/** Drive the entire pending queue to completion (used after `scan`). */
export async function drainQueue(opts: {
  root: string;
  registry?: ToolRegistry;
  out?: Out;
}): Promise<{ ran: number; failed: number }> {
  const out = opts.out ?? stdoutWrite;
  await scaffoldDataRoot(opts.root);
  const settingsStore = new SettingsStore(opts.root);
  const settings = await settingsStore.load();
  if (!settings.runner.enabled) await settingsStore.save({ ...settings, runner: { enabled: true } });
  const engine = new RunnerEngine({ root: opts.root, registry: opts.registry ?? new ToolRegistry() });
  let ran = 0;
  let failed = 0;
  for (;;) {
    const res = await streamTick(engine, opts.root, out);
    if (res.kind !== "ran") break;
    ran += 1;
    if (res.outcome.kind === "failed") failed += 1;
  }
  out(`\nqueue drained: ${ran} task(s) ran, ${failed} failed\n`);
  return { ran, failed };
}

export interface ScanOptions {
  root: string;
  repo: string;
  dryRun?: boolean;
  bumpTo?: BoofGoalRef["bumpTo"];
  tool?: string;
  model?: string;
  registry?: ToolRegistry;
  out?: Out;
}

export interface ScanSummary {
  created: string[];
  units: ScannedUnit[];
  dryRun: boolean;
}

/**
 * Scan `repo` for not-done goal.boof.xml units and create one pipeline task per
 * unit (dependency order → priority). With `dryRun`, only lists what it would
 * create. Sets the data root's workingDirectory to `repo` so the runner and the
 * status write-back both target the scanned repo.
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
  const store = new TaskStore(opts.root);
  const settingsStore = new SettingsStore(opts.root);
  const settings = await settingsStore.load();
  await settingsStore.save({ ...settings, workingDirectory: repo });

  const registry = opts.registry ?? new ToolRegistry();
  const tools = toolOverride(registry, opts.tool, opts.model);
  const bumpTo = opts.bumpTo ?? "done";
  const created: string[] = [];
  const taken = new Set((await store.list()).map((t) => t.frontmatter.id));

  // Highest priority first: units are already deps-first (blocked units last).
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const id = uniqueKebabId(`boof ${u.id}`, taken);
    taken.add(id);
    await store.create(
      newTask(
        {
          id,
          title: `boof: ${u.id}`,
          status: "pending",
          priority: (units.length - i) * 10,
          skip: false,
          labels: ["boof-scan", `boof-status:${u.status}`],
          command: null,
          attachments: [],
          questions: "none",
          runs: 1,
          completedRuns: 0,
          ...(tools ? { tools } : {}),
          boofGoal: { path: u.goalPath, bumpTo },
          created: "",
          updated: "",
        },
        buildUnitPrompt(u, repo),
      ),
    );
    created.push(id);
  }

  out(`\nCreated ${created.length} task(s). Run them with:  boof-runner run --all -d ${opts.root}\n`);
  return { created, units, dryRun: false };
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "task";
  return line.length > 80 ? line.slice(0, 80) : line;
}
