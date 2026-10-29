import { readdir, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWrite, readText, withFileLock } from "./atomic.js";
import { appendEvent } from "./events.js";
import { formatInjectedEntry, parseInjected, type InjectMode } from "./injected.js";
import { uniqueKebabId } from "./ids.js";
import { assertTransition } from "./lifecycle.js";
import { ALL_STATUSES, statusDir, taskControlDir, taskFilePath, workingAreaDir } from "./paths.js";
import { nowIso } from "./runtime.js";
import type { Status } from "./schema.js";
import { parseTask, serializeTask, type Task } from "./task-file.js";

/** Thrown when a task id does not exist in any status directory. */
export class TaskNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

/** Thrown by {@link TaskStore.whileRunning} when the task is not in the `running` status. */
export class TaskNotRunningError extends Error {
  constructor(
    public readonly id: string,
    public readonly status: Status,
  ) {
    super(`Task is not running: ${id} (${status})`);
    this.name = "TaskNotRunningError";
  }
}

/** Append an injected-prompt entry to the task's `## Injected` section (in memory, no write). */
export function appendInjectedEntry(
  task: Task,
  entry: { text: string; by?: string; mode?: InjectMode },
): void {
  const formatted = formatInjectedEntry({
    at: nowIso(),
    by: entry.by ?? "user",
    text: entry.text,
    ...(entry.mode ? { mode: entry.mode } : {}),
  });
  task.body.injected = task.body.injected.trim()
    ? `${task.body.injected.trimEnd()}\n\n${formatted}`
    : formatted;
}

/** Thrown when creating a task whose id already exists in some status directory. */
export class TaskExistsError extends Error {
  constructor(public readonly id: string) {
    super(`Task already exists: ${id}`);
    this.name = "TaskExistsError";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Read and reconcile the task file at `path` for a directory with `dirStatus`.
 * Returns null when the file disappeared after it was listed or located (the
 * runner moves tasks between status directories while readers run). Other
 * read errors are rethrown.
 */
export async function readTaskIfExists(path: string, dirStatus: Status): Promise<Task | null> {
  let raw: string;
  try {
    raw = await readText(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const task = parseTask(raw);
  // Location is authoritative: repair the frontmatter status if it drifted.
  if (task.frontmatter.status !== dirStatus) task.frontmatter.status = dirStatus;
  return task;
}

/**
 * `mutate` callbacks run under the task lock and must be synchronous: an async one would write
 * before its awaited part ran (losing the change), or deadlock if it awaited the same task id.
 */
function assertSyncMutate(result: unknown, op: string): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    (result as PromiseLike<unknown>).then(undefined, () => {}); // no unhandled rejection
    throw new TypeError(`TaskStore.${op}: mutate must be synchronous (it returned a promise)`);
  }
}

/**
 * File-backed task repository. The directory a task lives in is authoritative
 * for its status; on read we reconcile the frontmatter `status` to match the
 * location (task-lifecycle spec). All writes are atomic + locked.
 */
export class TaskStore {
  constructor(private readonly root: string) {}

  /**
   * Serialize every operation on one task id in this process: locate, check and write happen under
   * it. Other processes are not excluded (see atomic.ts).
   */
  private lockTask<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.root}#task:${id}`, fn);
  }

  /** Ensure all status directories exist (under the handed root: a project directory in v2). */
  async ensureDirs(): Promise<void> {
    for (const status of ALL_STATUSES) {
      await mkdir(statusDir(this.root, status), { recursive: true });
    }
  }

  /**
   * Read and reconcile every task across all status directories. Files removed
   * mid-read are skipped. A task seen in two status directories (a transition
   * writes the destination before removing the source) is reported once, using
   * the copy with the later `updated`; on a tie the first copy found wins.
   */
  async list(): Promise<Task[]> {
    const byId = new Map<string, Task>();
    for (const status of ALL_STATUSES) {
      for (const task of await this.listStatus(status)) {
        const id = task.frontmatter.id;
        const prev = byId.get(id);
        if (!prev || Date.parse(task.frontmatter.updated) > Date.parse(prev.frontmatter.updated)) {
          byId.set(id, task);
        }
      }
    }
    return [...byId.values()];
  }

  /** Read every task file in one status directory, skipping files that vanish. */
  private async listStatus(status: Status): Promise<Task[]> {
    const dir = statusDir(this.root, status);
    const out: Task[] = [];
    if (status === "running") {
      for (const id of await listSubdirs(dir)) {
        const task = await readTaskIfExists(join(dir, id, "task.md"), status);
        if (task) out.push(task);
      }
    } else {
      for (const name of await listMdFiles(dir)) {
        const task = await readTaskIfExists(join(dir, name), status);
        if (task) out.push(task);
      }
    }
    return out;
  }

  private async readReconciled(path: string, dirStatus: Status): Promise<Task> {
    const task = parseTask(await readText(path));
    // Location is authoritative: repair the frontmatter status if it drifted.
    if (task.frontmatter.status !== dirStatus) task.frontmatter.status = dirStatus;
    return task;
  }

  /**
   * Find a single task by id (searches all status dirs). If the located file
   * is removed before it is read (the task moved), locate again once.
   */
  async get(id: string): Promise<Task | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const located = await this.locate(id);
      if (!located) return null;
      const task = await readTaskIfExists(located.path, located.status);
      if (task) return task;
    }
    return null;
  }

  /** Locate a task's current file path + dir-status, or null. */
  async locate(id: string): Promise<{ status: Status; path: string } | null> {
    for (const status of ALL_STATUSES) {
      const p = taskFilePath(this.root, status, id);
      if (await exists(p)) return { status, path: p };
    }
    return null;
  }

  /**
   * Write a task in place (no status change). Refreshes `updated`, preserving
   * `created`. Written at the location matching its current status.
   */
  async save(task: Task): Promise<Task> {
    const id = task.frontmatter.id;
    return this.lockTask(id, async () => {
      // The directory is authoritative: write where the task is now, not where the copy says.
      const located = await this.locate(id);
      if (!located) throw new TaskNotFoundError(id);
      task.frontmatter.updated = nowIso();
      task.frontmatter.status = located.status;
      // `## Injected` is append-only and written by appendInjected: a save from a copy read
      // earlier (the runner's in-memory task, an editor) must not drop an entry added since.
      const disk = await readText(located.path)
        .then(parseTask)
        .catch(() => null);
      if (disk) {
        task.body.injected = disk.body.injected;
        if (disk.frontmatter.startedAt) task.frontmatter.startedAt = disk.frontmatter.startedAt;
        if (disk.frontmatter.steps) task.frontmatter.steps = disk.frontmatter.steps;
      }
      await atomicWrite(located.path, serializeTask(task));
      return task;
    });
  }

  /**
   * Read-modify-write under the task lock: re-reads the file, applies `mutate` and writes it back,
   * so a writer changes only the fields it owns and keeps edits made since it loaded its copy.
   */
  async modify(id: string, mutate: (t: Task) => void): Promise<Task> {
    return this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) throw new TaskNotFoundError(id);
      const task = await this.readReconciled(located.path, located.status);
      assertSyncMutate(mutate(task), "modify");
      task.frontmatter.updated = nowIso();
      await atomicWrite(located.path, serializeTask(task));
      return task;
    });
  }

  /**
   * Append an injected prompt to the task's durable `## Injected` section (the control-dir copy
   * is deleted when the task leaves `running`). `by` is the principal name, default "user".
   */
  async appendInjected(id: string, text: string, by = "user", mode?: InjectMode): Promise<Task> {
    return this.modify(id, (t) => appendInjectedEntry(t, { text, by, mode }));
  }

  /**
   * Run `fn` under the task lock while the task is `running`, with its control directory created.
   * A transition out of `running` queues behind it, so control files are never written into a
   * working area that is being removed. `mutate` (sync) edits the task in the same critical
   * section; the task is then written back. Throws {@link TaskNotRunningError} otherwise.
   */
  async whileRunning(
    id: string,
    fn: (ctx: { task: Task; controlDir: string }) => Promise<void>,
    mutate?: (t: Task) => void,
  ): Promise<Task> {
    return this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) throw new TaskNotFoundError(id);
      if (located.status !== "running") throw new TaskNotRunningError(id, located.status);
      const task = await this.readReconciled(located.path, located.status);
      const controlDir = taskControlDir(this.root, id);
      await mkdir(controlDir, { recursive: true });
      await fn({ task, controlDir });
      if (mutate) {
        assertSyncMutate(mutate(task), "whileRunning");
        task.frontmatter.updated = nowIso();
        await atomicWrite(located.path, serializeTask(task));
      }
      return task;
    });
  }

  /**
   * Stamp every injected entry that has no `applied` time yet: its prompt just reached the
   * agent. Writes nothing when there is nothing to stamp.
   */
  async markInjectedApplied(id: string, at = nowIso()): Promise<void> {
    await this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) return;
      const task = await this.readReconciled(located.path, located.status);
      const entries = parseInjected(task.body.injected);
      if (entries.every((e) => e.appliedAt)) return;
      task.body.injected = entries
        .map((e) => formatInjectedEntry(e.appliedAt ? e : { ...e, appliedAt: at }))
        .join("\n\n");
      await atomicWrite(located.path, serializeTask(task));
    });
  }

  /** Record that a pipeline step began (label + time) in the task's `steps`. No-op if the task is gone. */
  async appendStep(id: string, label: string, at = nowIso()): Promise<void> {
    await this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) return;
      const task = await this.readReconciled(located.path, located.status);
      task.frontmatter.steps = [...(task.frontmatter.steps ?? []), { label, at }];
      await atomicWrite(located.path, serializeTask(task));
    });
  }

  /** Create a brand-new task file and append a `task.created` event (`opts.by`: the actor). */
  async create(task: Task, opts: { by?: string } = {}): Promise<Task> {
    const now = nowIso();
    task.frontmatter.created = task.frontmatter.created || now;
    task.frontmatter.updated = now;
    const path = taskFilePath(this.root, task.frontmatter.status, task.frontmatter.id);
    await this.lockTask(task.frontmatter.id, async () => {
      if (await this.locate(task.frontmatter.id)) throw new TaskExistsError(task.frontmatter.id);
      try {
        await atomicWrite(path, serializeTask(task), { exclusive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new TaskExistsError(task.frontmatter.id);
        }
        throw err;
      }
    });
    await appendEvent(this.root, {
      type: "task.created",
      project: basename(this.root),
      task: task.frontmatter.id,
      status: task.frontmatter.status,
      by: opts.by ?? "runner",
    });
    return task;
  }

  /**
   * Create `task` under a fresh kebab id derived from its title. Concurrent creates with one
   * title pick the same id; the loser retries with a new one (up to 5 attempts, then
   * {@link TaskExistsError}).
   */
  async createUnique(task: Task, opts: { by?: string } = {}): Promise<Task> {
    for (let attempt = 0; ; attempt += 1) {
      const ids = (await this.list()).map((t) => t.frontmatter.id);
      task.frontmatter.id = uniqueKebabId(task.frontmatter.title, ids);
      try {
        return await this.create(task, opts);
      } catch (err) {
        if (!(err instanceof TaskExistsError) || attempt >= 4) throw err;
      }
    }
  }

  /**
   * Transition a task to a new status: validate, write the file with the new
   * status, then remove the old location (write-then-move ordering). Returns
   * the moved task. `mutate` lets the caller adjust frontmatter/body atomically.
   * Appends a `task.status` event (and `task.questions` when the task parks with questions);
   * `opts.by` names the actor (principal id), default `runner`; `opts.reason` is recorded on the event.
   */
  async transition(
    id: string,
    to: Status,
    mutate?: (t: Task) => void,
    opts: { by?: string; reason?: string } = {},
  ): Promise<Task> {
    const { task, fromStatus } = await this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) throw new TaskNotFoundError(id);
      assertTransition(located.status, to);

      const task = await this.readReconciled(located.path, located.status);
      task.frontmatter.status = to;
      task.frontmatter.updated = nowIso();
      if (to === "running") {
        task.frontmatter.startedAt = nowIso();
        task.frontmatter.steps = [];
      }
      if (mutate) assertSyncMutate(mutate(task), "transition");

      const destPath = taskFilePath(this.root, to, id);
      await mkdir(dirname(destPath), { recursive: true });
      if (to === "running") {
        // A run starts with no control files (a stale stop/steer must not hit the new run).
        await rm(taskControlDir(this.root, id), { recursive: true, force: true });
      }
      await atomicWrite(destPath, serializeTask(task));
      if (located.path !== destPath) {
        if (located.status === "running") {
          await rmWorkingArea(workingAreaDir(this.root, id));
        } else {
          await rm(located.path, { force: true });
        }
      }
      return { task, fromStatus: located.status };
    });
    const by = opts.by ?? "runner";
    const project = basename(this.root);
    await appendEvent(this.root, {
      type: "task.status",
      project,
      task: id,
      from: fromStatus,
      to,
      by,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    if (to === "action" && task.frontmatter.questions === "pending") {
      const count = task.body.questions.split("\n").filter((l) => l.trim() !== "").length;
      await appendEvent(this.root, { type: "task.questions", project, task: id, count, by });
    }
    return task;
  }

  /**
   * Permanently remove a task. For a `running` task the whole working-area
   * directory (ongoing/<id>/) is removed; every other status is a flat file.
   * No-op if the task is already gone.
   */
  async delete(id: string): Promise<void> {
    await this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) return;
      if (located.status === "running") {
        await rmWorkingArea(workingAreaDir(this.root, id));
      } else {
        await rm(located.path, { force: true });
      }
    });
  }

  /** Toggle the orthogonal skip flag without changing status/location. */
  async setSkip(id: string, skip: boolean): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new TaskNotFoundError(id);
    task.frontmatter.skip = skip;
    return this.save(task);
  }
}

/**
 * Remove a task's working area. The control directory is written by other processes (the inject
 * and stop APIs) up to the moment the task leaves `running`, so a recursive remove can meet a
 * file created mid-walk and fail with ENOTEMPTY; retry instead of failing the transition.
 */
function rmWorkingArea(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
