import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWrite, lockedAtomicWrite } from "./atomic.js";
import { dataRootPaths, projectPaths } from "./paths.js";
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
}

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
    return { kind: "current", log: [] };
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
