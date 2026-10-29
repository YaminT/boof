import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWrite, lockedAtomicWrite, withFileLock } from "./atomic.js";
import { dataRootPaths, projectPaths } from "./paths.js";
import { PlanSchema } from "./plan-schema.js";
import { nowIso } from "./runtime.js";
import {
  LegacySettingsSchema,
  ProjectSchema,
  SettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  type Project,
} from "./schema.js";
import { defaultSettings } from "./settings.js";

/** The data root cannot be migrated right now (live runner) or is from a newer release. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationResult {
  /** `fresh`: new v2 root; `migrated`: v1 -> v2 ran (or finished a crashed run); `current`: nothing to do. */
  kind: "fresh" | "migrated" | "current";
  /** Lines describing what moved (also written to migration-v2.log). */
  log: string[];
}

export interface MigrateOptions {
  /** Liveness probe for the pid in .runner.pid; default `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** How long to wait for another process's migration lock; default 30 000 ms. */
  lockTimeoutMs?: number;
  /** Poll interval while waiting for the lock; default 50 ms. */
  lockPollMs?: number;
  /** Our pid in the lock file; default `process.pid`. Tests use it to simulate other processes. */
  pid?: number;
}

/** `<root>/.migration.lock`: holds the pid of the process migrating the root. */
export const MIGRATION_LOCK_FILE = ".migration.lock";

export const DEFAULT_PROJECT_ID = "default";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runnerIsLive(pidFile: string, alive: (pid: number) => boolean): Promise<boolean> {
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    return Boolean(pid) && pid !== process.pid && alive(pid);
  } catch {
    return false;
  }
}

async function hasOngoingTask(tasksDir: string): Promise<boolean> {
  try {
    return (await readdir(join(tasksDir, "ongoing"))).length > 0;
  } catch {
    return false;
  }
}

/** Move `src` into `dst`; where `dst` exists, merge directories and keep dst's files. Returns leftovers. */
async function mergeInto(src: string, dst: string): Promise<string[]> {
  const left: string[] = [];
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (!(await exists(to))) {
      await rename(from, to);
    } else if (entry.isDirectory() && (await stat(to)).isDirectory()) {
      left.push(...(await mergeInto(from, to)));
    } else {
      left.push(from);
    }
  }
  if (left.length === 0) await rm(src, { recursive: true, force: true });
  return left;
}

/**
 * Bring a data root to layout v2 (multi-project spec section 7). Safe to call on every start:
 *  - no settings.json: scaffold v2 settings (no projects);
 *  - settings.json without `schemaVersion` (v1): move tasks/ and usage.json into
 *    projects/default/, then rewrite settings.json last, so a crash leaves a v1 file and the
 *    next run finishes the remaining steps (each step checks its own precondition);
 *  - `schemaVersion: 2`: nothing.
 * Throws MigrationError when a task is running under a live runner, or the root is newer.
 */
export async function migrateDataRoot(
  root: string,
  opts: MigrateOptions = {},
): Promise<MigrationResult> {
  // Fast path: settings.json is written last and atomically, so a v2 file means nothing to do.
  try {
    const raw = JSON.parse(await readFile(dataRootPaths(root).settings, "utf8")) as {
      schemaVersion?: unknown;
    };
    if (raw?.schemaVersion === SETTINGS_SCHEMA_VERSION) {
      // Unlocked, read-only look; the locked path re-checks, so two processes backfill once.
      if (!(await hasUnapprovedActivePlan(root))) return { kind: "current", log: [] };
    }
  } catch {
    // missing or unreadable: the locked path decides (and reports) it
  }
  return withMigrationLock(root, opts, () => migrateUnlocked(root, opts));
}

/** Plan files `<root>/projects/<project>/plans/<plan>.json`; unreadable or invalid ones are skipped. */
async function* planFiles(root: string) {
  let projects: string[];
  try {
    projects = (await readdir(dataRootPaths(root).projects)).sort();
  } catch {
    return;
  }
  for (const project of projects) {
    const dir = join(dataRootPaths(root).projects, project, "plans");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        yield {
          project,
          id: name.slice(0, -".json".length),
          path,
          raw,
          plan: PlanSchema.parse(raw),
        };
      } catch {
        // skip
      }
    }
  }
}

async function hasUnapprovedActivePlan(root: string): Promise<boolean> {
  for await (const f of planFiles(root)) {
    if (f.plan.status === "active" && !f.plan.approvedBy) return true;
  }
  return false;
}

/**
 * Stamp `approvedBy` (principal "migration", the plan's current version) on every `active` plan
 * that has none: those predate approvals, and a human made them active. Drafts, archived plans
 * and existing approvals are untouched, and so are `version` and `updated`: a repair, not an
 * edit, so no event. Call under the migration lock. Returns one log line per plan.
 */
export async function backfillPlanApprovals(
  root: string,
  at: string = nowIso(),
): Promise<string[]> {
  const log: string[] = [];
  for await (const f of planFiles(root)) {
    if (f.plan.status !== "active" || f.plan.approvedBy) continue;
    await withFileLock(f.path, async () => {
      // re-read under the plan lock: it may have been approved since the scan
      const fresh = JSON.parse(await readFile(f.path, "utf8")) as Record<string, unknown>;
      const plan = PlanSchema.parse(fresh);
      if (plan.status !== "active" || plan.approvedBy) return;
      const next = {
        ...fresh,
        approvedBy: { principalId: "migration", at, version: plan.version },
      };
      await atomicWrite(f.path, JSON.stringify(next, null, 2) + "\n");
      log.push(
        `backfilled approval of plan ${f.project}/${f.id} (activated before approvals were recorded)`,
      );
    }).catch(() => undefined);
  }
  return log;
}

/** Same-process callers queue here so a lock file naming our own pid can only be stale. */
const localQueues = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A takeover guard is held for microseconds; one older than this was left by a crash. */
const TAKEOVER_GUARD_STALE_MS = 5000;

/**
 * Run `fn` while holding the cross-process migration lock on `root`. Later start-up work that
 * must not race another process (backfills) belongs inside the same lock.
 * Callers in this process queue in memory. A lock file whose pid is dead, or is our own pid
 * while we are not holding it (pid reuse after a reboot), is stale and is taken over under an
 * exclusive `.migration.lock.takeover` guard, so only one process removes it. A live holder is
 * waited for until `lockTimeoutMs`; a holder value that is not a positive integer is treated as
 * still being written and is never taken over.
 * Liveness is checked locally, so a lock left by a process on another host sharing the root
 * whose pid is unused here reads as dead and is taken over: data roots shared across hosts are
 * not supported.
 */
export async function withMigrationLock<T>(
  root: string,
  opts: MigrateOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const pid = opts.pid ?? process.pid;
  const lock = join(root, MIGRATION_LOCK_FILE);
  const key = `${lock}\0${pid}`;
  const previous = localQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  localQueues.set(key, tail);
  await previous;
  try {
    await acquireFileLock(root, lock, pid, opts);
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  } finally {
    release();
    if (localQueues.get(key) === tail) localQueues.delete(key);
  }
}

async function acquireFileLock(
  root: string,
  lock: string,
  pid: number,
  opts: MigrateOptions,
): Promise<void> {
  const alive = opts.isProcessAlive ?? defaultAlive;
  const timeoutMs = opts.lockTimeoutMs ?? 30_000;
  const pollMs = opts.lockPollMs ?? 50;
  const guard = `${lock}.takeover`;
  await mkdir(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await atomicWrite(lock, `${pid}\n`, { exclusive: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let text: string;
    try {
      text = (await readFile(lock, "utf8")).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // just released
      throw err;
    }
    const holder = Number(text);
    const valid = /^\d+$/.test(text) && holder > 0;
    if (valid && (holder === pid || !alive(holder))) {
      if (await takeOver(lock, guard, text)) continue;
    }
    if (Date.now() >= deadline) {
      throw new MigrationError(
        `another boof-runner process is migrating ${root} (pid ${text}); try again in a moment`,
      );
    }
    await sleep(pollMs);
  }
}

/** Remove the stale lock naming `text` while holding the takeover guard; false = guard busy. */
async function takeOver(lock: string, guard: string, text: string): Promise<boolean> {
  try {
    await atomicWrite(guard, `${process.pid}\n`, { exclusive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = await stat(guard).then(
      (st) => Date.now() - st.mtimeMs,
      () => 0,
    );
    if (age > TAKEOVER_GUARD_STALE_MS) await rm(guard, { force: true });
    return false;
  }
  try {
    const again = await readFile(lock, "utf8").catch(() => null);
    if (again !== null && again.trim() === text) await rm(lock, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
  return true;
}

async function migrateUnlocked(root: string, opts: MigrateOptions): Promise<MigrationResult> {
  const paths = dataRootPaths(root);
  const legacyTasks = join(root, "tasks");
  const legacyUsage = join(root, "usage.json");

  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MigrationError(`cannot read ${paths.settings}: ${(err as Error).message}`);
    }
  }

  if (raw && "schemaVersion" in raw) {
    if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      throw new MigrationError(
        `${paths.settings} has schemaVersion ${String(raw.schemaVersion)}, newer than this boof-runner supports (${SETTINGS_SCHEMA_VERSION}); upgrade boof-runner`,
      );
    }
    const log = await backfillPlanApprovals(root);
    if (log.length > 0)
      await appendFile(join(root, "migration-v2.log"), log.join("\n") + "\n", "utf8");
    return { kind: "current", log };
  }

  if (!raw && !(await exists(legacyTasks))) {
    await mkdir(paths.projects, { recursive: true });
    await lockedAtomicWrite(
      paths.settings,
      JSON.stringify(SettingsSchema.parse(defaultSettings()), null, 2) + "\n",
    );
    return { kind: "fresh", log: [] };
  }

  // v1 (or a v1 tasks/ tree whose settings.json is missing).
  const alive = opts.isProcessAlive ?? defaultAlive;
  if ((await hasOngoingTask(legacyTasks)) && (await runnerIsLive(paths.runnerPid, alive))) {
    throw new MigrationError(
      "cannot migrate the data root to v2: a task is running and the runner is alive; stop the runner and start boof-runner again",
    );
  }

  let legacy;
  try {
    legacy = LegacySettingsSchema.parse(
      raw ?? { ...defaultSettings(), workingDirectory: "", runner: { enabled: false } },
    );
  } catch (err) {
    throw new MigrationError(`cannot parse v1 settings.json: ${(err as Error).message}`);
  }

  const log: string[] = [`${nowIso()} migrating ${root} from v1 to v2`];
  const project = projectPaths(root, DEFAULT_PROJECT_ID);
  await mkdir(project.dir, { recursive: true });

  // 1. project.json (skip if a previous, interrupted run already wrote it).
  if (await exists(project.json)) {
    log.push("project.json already present, kept");
  } else {
    const wd = legacy.workingDirectory.trim()
      ? await realpath(legacy.workingDirectory).catch(() => legacy.workingDirectory)
      : "";
    const now = nowIso();
    const created: Project = ProjectSchema.parse({
      id: DEFAULT_PROJECT_ID,
      name: (wd && basename(wd)) || DEFAULT_PROJECT_ID,
      workingDirectory: wd,
      origin: { kind: "migration" },
      created: now,
      updated: now,
    });
    await atomicWrite(project.json, JSON.stringify(created, null, 2) + "\n");
    log.push(
      `wrote projects/${DEFAULT_PROJECT_ID}/project.json (workingDirectory: ${JSON.stringify(wd)})`,
    );
  }

  // 2. tasks/ -> projects/default/tasks/
  if (await exists(legacyTasks)) {
    const leftovers = await mergeInto(legacyTasks, project.tasks);
    log.push("moved tasks/ to projects/default/tasks/");
    for (const l of leftovers) log.push(`kept conflicting v1 file in place: ${l}`);
  } else {
    log.push("tasks/ already moved");
  }

  // 3. usage.json -> projects/default/usage.json
  if (await exists(legacyUsage)) {
    if (await exists(project.usage)) {
      log.push("usage.json left in place: projects/default/usage.json already exists");
    } else {
      await rename(legacyUsage, project.usage);
      log.push("moved usage.json to projects/default/usage.json");
    }
  } else {
    log.push("usage.json already moved or absent");
  }

  // 4. settings.json last: its version marks the migration complete.
  const { workingDirectory: _wd, ...rest } = legacy;
  void _wd;
  const next = SettingsSchema.parse({
    ...rest,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    runner: { enabled: legacy.runner.enabled, concurrency: 1 },
    defaultProject: DEFAULT_PROJECT_ID,
  });
  await mkdir(paths.commands, { recursive: true });
  await appendFile(join(root, "migration-v2.log"), log.join("\n") + "\n", "utf8");
  await lockedAtomicWrite(paths.settings, JSON.stringify(next, null, 2) + "\n");
  return { kind: "migrated", log };
}
