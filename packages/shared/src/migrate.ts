import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWrite, lockedAtomicWrite, withFileLock } from "./atomic.js";
import { defaultAlive, withProcessLock } from "./process-lock.js";
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
import { tightenAuthDir } from "./auth-store.js";
import { isUsableSecret, WebhookSecretStore } from "./webhook-secrets.js";

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
  // An older data root may have the key directory looser than 0700.
  await tightenAuthDir(root);
  // Fast path: settings.json is written last and atomically, so a v2 file means nothing to do.
  try {
    const raw = JSON.parse(await readFile(dataRootPaths(root).settings, "utf8")) as {
      schemaVersion?: unknown;
      webhooks?: unknown;
    };
    if (raw?.schemaVersion === SETTINGS_SCHEMA_VERSION) {
      // Unlocked, read-only look; the locked path re-checks, so two processes backfill once.
      if (!settingsHoldSecrets(raw) && !(await hasUnapprovedActivePlan(root)))
        return { kind: "current", log: [] };
    }
  } catch {
    // missing or unreadable: the locked path decides (and reports) it
  }
  return withMigrationLock(root, opts, () => migrateUnlocked(root, opts));
}

function settingsHoldSecrets(raw: { webhooks?: unknown }): boolean {
  return (
    Array.isArray(raw.webhooks) &&
    raw.webhooks.some((h) => typeof (h as { secret?: unknown } | null)?.secret === "string")
  );
}

/**
 * Move webhook secrets from settings.json into webhooks/secrets.json (0600). settings.json is
 * rewritten last, so a crash leaves both copies and the next run finishes; a secret already in
 * the file wins. Returns one log line per moved secret.
 */
export async function moveWebhookSecrets(root: string): Promise<string[]> {
  const paths = dataRootPaths(root);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const store = new WebhookSecretStore(root);
  await store.tighten();
  if (!settingsHoldSecrets(raw)) return [];
  const hooks = raw.webhooks as Array<Record<string, unknown>>;
  const log: string[] = [];
  for (const hook of hooks) {
    if (typeof hook?.secret !== "string") continue;
    const id = String(hook.id);
    if (!isUsableSecret(hook.secret)) {
      log.push(`dropped the unusable secret of webhook ${id}; delete and re-create the webhook`);
      continue;
    }
    if ((await store.get(id)) === null) await store.set(id, hook.secret);
    log.push(`moved the secret of webhook ${id} to webhooks/secrets.json`);
  }
  await lockedAtomicWrite(
    paths.settings,
    JSON.stringify({ ...raw, webhooks: hooks.map(({ secret: _s, ...h }) => h) }, null, 2) + "\n",
  );
  return log;
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
    }).catch((err: unknown) => {
      // The next start retries; the line keeps a plan that never gets backfilled visible.
      log.push(
        `could not backfill approval of plan ${f.project}/${f.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return log;
}

/**
 * Run `fn` while holding the cross-process migration lock on `root`. Later start-up work that
 * must not race another process (backfills) belongs inside the same lock. See `withProcessLock`
 * for the stale-holder rules.
 */
export function withMigrationLock<T>(
  root: string,
  opts: MigrateOptions,
  fn: () => Promise<T>,
): Promise<T> {
  return withProcessLock(
    join(root, MIGRATION_LOCK_FILE),
    opts,
    fn,
    (holder) =>
      new MigrationError(
        `another boof-runner process is migrating ${root} (pid ${holder}); try again in a moment`,
      ),
  );
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
    const log = [...(await moveWebhookSecrets(root)), ...(await backfillPlanApprovals(root))];
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
