import { readdir, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite, readText } from "./atomic.js";
import { appendEvent } from "./events.js";
import { formatInjectedEntry, parseInjected, type InjectMode } from "./injected.js";
import { uniqueKebabId } from "./ids.js";
import { assertTransition } from "./lifecycle.js";
import { ALL_STATUSES, statusDir, taskControlDir, taskFilePath, workingAreaDir } from "./paths.js";
import { withProcessLock, type ProcessLockOptions } from "./process-lock.js";
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

/** Thrown by {@link TaskStore.delete} with `refuseRunning` when the task is running. */
export class TaskRunningError extends Error {
  constructor(public readonly id: string) {
    super(`Cannot delete a running task: ${id}; wait for it to finish first`);
    this.name = "TaskRunningError";
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
  entry: { text: string; by?: string; mode?: InjectMode; model?: string },
): void {
  const formatted = formatInjectedEntry({
    at: nowIso(),
    by: entry.by ?? "user",
    text: entry.text,
    ...(entry.mode ? { mode: entry.mode } : {}),
    ...(entry.model ? { model: entry.model } : {}),
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

const MAX_SCAN_ROUNDS = 5;
/** How many task files a scan reads at once. High enough to hide syscall latency, low enough to stay under a small open-file limit. */
const READ_CONCURRENCY = 32;
/** Parsed-task caches kept at once. A long test run creates a root per case; production keeps one per project. */
const MAX_CACHED_ROOTS = 64;

/**
 * Finished status moves per task root in this process. A scan that overlapped one is repeated:
 * a task moving to an earlier directory can be missed by both reads, and the directory-name check
 * alone cannot see a task that flips back and forth quickly.
 */
const moveCount = new Map<string, number>();
const moveKey = (root: string) => resolve(root);

/**
 * Process-local index of one task root. `statusSummary` is the directory listing (status is the
 * directory), remembered until a status directory's mtime changes or this process creates, moves
 * or deletes a task. `files` remembers a parsed file until its mtime or size changes, or this
 * process writes that id (`idGen`). Timestamps come from `stat(..., { bigint: true })`: the
 * ordinary `Stats` object has no `mtimeNs` on this Node, so a number stat would never invalidate.
 * Callers never receive the stored object.
 */
interface RootCache {
  structureGen: number;
  idGen: Map<string, number>;
  files: Map<string, { mtimeNs: bigint; ctimeNs: bigint; ino: bigint; size: bigint; task: Task }>;
  summary?: {
    gen: number;
    mtimeNs: bigint[];
    counts: Record<string, number>;
    running: string[];
  };
  /**
   * Parsed files of one flat status directory (not `running`). A repeat call reuses them while
   * the directory mtime is unchanged. When the mtime changes, names already parsed are reused
   * and only a new name, or an id this process has written, is read again. The same set of
   * names with a new mtime is read in full: an outside replace of an existing file looks like
   * that, and a filename cannot say which file was replaced.
   */
  statusLists?: Map<Status, StatusListCache>;
}

interface StatusListEntry {
  /** `idGen` for this id when `task` was read. A later {@link TaskStore} write does not match. */
  idGen: number;
  task: Task;
  fingerprint?: FileFingerprint;
}

interface FileFingerprint {
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  size: bigint;
}

interface StatusListCache {
  /**
   * Directory mtime this list was scanned at, or `-1n` when a write in this process has to be
   * picked up before the mtime can be trusted.
   */
  mtimeNs: bigint;
  /** Wall clock when the directory scan completed; fresh mtimes are unsafe on coarse clocks. */
  scanTimeNs: bigint;
  byName: Map<string, StatusListEntry>;
}

const STATUS_MTIME_TICK_NS = 2_000_000_000n;

const rootCaches = new Map<string, RootCache>();
const MAX_CACHED_TASK_FILES = 4096;

function cacheFor(root: string): RootCache {
  const key = moveKey(root);
  const existing = rootCaches.get(key);
  if (existing) {
    rootCaches.delete(key);
    rootCaches.set(key, existing);
    return existing;
  }
  const created: RootCache = { structureGen: 0, idGen: new Map(), files: new Map() };
  rootCaches.set(key, created);
  while (rootCaches.size > MAX_CACHED_ROOTS) {
    const oldest = rootCaches.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    rootCaches.delete(oldest);
  }
  return created;
}

/** Counts and the running ids, without task bodies. Statuses with no tasks are absent. */
export interface TaskStatusSummary {
  counts: Record<string, number>;
  running: string[];
}

function copySummary(summary: TaskStatusSummary): TaskStatusSummary {
  return { counts: { ...summary.counts }, running: [...summary.running] };
}

/** A caller may mutate the task `list` returned. The cached one must stay as it was parsed. */
function cloneTask(task: Task): Task {
  return {
    frontmatter: structuredClone(task.frontmatter),
    body: {
      prompt: task.body.prompt,
      command: task.body.command,
      questions: task.body.questions,
      answers: task.body.answers,
      reports: { ...task.body.reports },
      log: task.body.log,
      injected: task.body.injected,
    },
  };
}

function sameBigints(a: readonly bigint[], b: readonly bigint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!, index);
      }
    }),
  );
  return out;
}

/** Task-file reads since the last call. A test hook for the list/status scan budget. */
let taskFileReads = 0;
export function takeTaskFileReads(): number {
  const n = taskFileReads;
  taskFileReads = 0;
  return n;
}

/** `stat` calls made while reading a task file (not a status-directory mtime check). */
let taskStatCalls = 0;
export function takeTaskStatCalls(): number {
  const n = taskStatCalls;
  taskStatCalls = 0;
  return n;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
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
  taskFileReads += 1;
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
  constructor(
    private readonly root: string,
    /** Test hook: timeouts, polling and liveness of the cross-process task lock. */
    private readonly opts: { lock?: ProcessLockOptions } = {},
  ) {}

  /**
   * Serialize every operation on one task id across processes (the server's runner, the CLI, MCP
   * stdio): locate, check and write happen under it. The lock is the file
   * `<root>/tasks/.locks/<id>.lock` (`withProcessLock`, which also queues callers in this process).
   * It is not in a status directory, because the task file moves between them and readers list
   * them; it is removed on release.
   */
  private lockTask<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return withProcessLock(
      join(this.root, "tasks", ".locks", `${id}.lock`),
      this.opts.lock ?? {},
      fn,
      (holder, path) =>
        new Error(
          `Task ${id} is being changed by another boof process (pid ${holder}); try again in a moment, or remove ${path} if no boof process is running`,
        ),
    );
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
   *
   * A task that moves to an earlier directory while the scan runs (running → pending) could be
   * missed by both reads, so the scan is repeated until a cheap listing of the directory names
   * matches the names the scan saw (at most MAX_SCAN_ROUNDS). If it never settles, the last round
   * is returned plus every id seen in an earlier round and read again now (a task deleted
   * meanwhile drops out), so an id seen in any round is not lost.
   */
  async list(): Promise<Task[]> {
    const union = new Map<string, Task>();
    for (let round = 1; ; round++) {
      const moves = moveCount.get(moveKey(this.root)) ?? 0;
      const names = new Set<string>();
      const byId = new Map<string, Task>();
      for (const status of ALL_STATUSES) {
        for (const task of await this.listStatus(status, names)) {
          const id = task.frontmatter.id;
          const prev = byId.get(id);
          if (
            !prev ||
            Date.parse(task.frontmatter.updated) > Date.parse(prev.frontmatter.updated)
          ) {
            byId.set(id, task);
          }
        }
      }
      for (const [id, task] of byId) union.set(id, task);
      const settled =
        moves === (moveCount.get(moveKey(this.root)) ?? 0) &&
        sameSet(names, await this.listNames());
      if (settled) {
        this.pruneFileCache(names);
        return [...byId.values()];
      }
      if (round >= MAX_SCAN_ROUNDS) {
        // Ids seen in an earlier round but not the last: read them again, so a deleted task drops
        // out and a moved one has its true status.
        for (const id of union.keys()) {
          if (byId.has(id)) continue;
          const now = await this.get(id);
          if (now) byId.set(id, now);
        }
        return [...byId.values()];
      }
    }
  }

  /** `status/name` of every task entry, without reading the files. */
  private async listNames(into: Set<string> = new Set()): Promise<Set<string>> {
    // One directory read per status, at the same time. A status poll used to wait for each
    // read in turn, and under the soak that wait was the whole request.
    await Promise.all(ALL_STATUSES.map((status) => this.listStatusNames(status, into)));
    return into;
  }

  private async listStatusNames(status: Status, into: Set<string>): Promise<string[]> {
    const dir = statusDir(this.root, status);
    const names = status === "running" ? await listSubdirs(dir) : await listMdFiles(dir);
    for (const n of names) into.add(`${status}/${n}`);
    return names;
  }

  /**
   * Counts and running ids from the status directories. The directory is the status and the
   * filename (or `ongoing/<id>/`) is the id, which is how every write in this store names the
   * file, so the files themselves are not parsed. A task that is in two directories at once
   * (a transition writes the destination first) is counted once, under the copy with the later
   * `updated`. A running directory with no `task.md` is not a task.
   */
  async statusSummary(): Promise<TaskStatusSummary> {
    const cache = cacheFor(this.root);
    const mtimes = await this.statusDirMtimes();
    const hit = cache.summary;
    if (hit && hit.gen === cache.structureGen && sameBigints(hit.mtimeNs, mtimes)) {
      return copySummary(hit);
    }
    const gen = cache.structureGen;
    const fresh = await this.scanStatusSummary();
    const after = await this.statusDirMtimes();
    if (cache.structureGen === gen && sameBigints(mtimes, after)) {
      cache.summary = { gen, mtimeNs: after, counts: fresh.counts, running: fresh.running };
    }
    return copySummary(fresh);
  }

  private statusDirMtimes(): Promise<bigint[]> {
    return Promise.all(
      ALL_STATUSES.map(async (status) => {
        try {
          return (await stat(statusDir(this.root, status), { bigint: true })).mtimeNs;
        } catch (err) {
          if (!isNotFound(err)) throw err;
          return 0n;
        }
      }),
    );
  }

  /** Name scan behind {@link statusSummary}. Repeats when a move overlaps it, like {@link list}. */
  private async scanStatusSummary(): Promise<TaskStatusSummary> {
    for (let round = 1; ; round++) {
      const moves = moveCount.get(moveKey(this.root)) ?? 0;
      const names = new Set<string>();
      const byId = new Map<string, Status>();
      const dups = new Map<string, Status[]>();
      const listed = await Promise.all(
        ALL_STATUSES.map(async (status) => {
          const found = await this.listStatusNames(status, names);
          if (status !== "running") return { status, ids: found.map((name) => name.slice(0, -3)) };
          const dir = statusDir(this.root, status);
          const ids = (
            await Promise.all(
              found.map(async (id) => ((await exists(join(dir, id, "task.md"))) ? id : null)),
            )
          ).filter((id): id is string => id !== null);
          return { status, ids };
        }),
      );
      for (const { status, ids } of listed) {
        for (const id of ids) {
          const prev = byId.get(id);
          if (prev === undefined) {
            byId.set(id, status);
            continue;
          }
          const seen = dups.get(id);
          if (seen) seen.push(status);
          else dups.set(id, [prev, status]);
        }
      }
      for (const [id, statuses] of dups) {
        let best: { status: Status; updated: number } | null = null;
        for (const status of statuses) {
          const path =
            status === "running"
              ? join(statusDir(this.root, status), id, "task.md")
              : join(statusDir(this.root, status), `${id}.md`);
          const task = await readTaskIfExists(path, status);
          if (!task) continue;
          const updated = Date.parse(task.frontmatter.updated);
          if (!best || updated > best.updated) best = { status, updated };
        }
        if (best) byId.set(id, best.status);
        else byId.delete(id);
      }
      const settled =
        moves === (moveCount.get(moveKey(this.root)) ?? 0) &&
        sameSet(names, await this.listNames());
      if (settled || round >= MAX_SCAN_ROUNDS) {
        const counts: Record<string, number> = {};
        const running: string[] = [];
        for (const [id, status] of byId) {
          counts[status] = (counts[status] ?? 0) + 1;
          if (status === "running") running.push(id);
        }
        return { counts, running };
      }
    }
  }

  /**
   * Tasks in one status directory. The directory is the status, so a finished task is not
   * opened to answer "what is pending". For every status except `running` (whose task file
   * lives in a subdirectory), a repeat call stats each cached file before reusing its parse.
   * Fresh directory mtimes are re-scanned for two seconds to cover coarse timestamp ticks. A
   * task mid-move can still appear in its old directory until that copy is removed; {@link list}
   * is the scan that collapses the two copies.
   */
  async listByStatus(status: Status): Promise<Task[]> {
    if (status === "running") return this.listStatus(status);
    const cache = cacheFor(this.root);
    const before = await this.statusDirMtime(status);
    const hit = cache.statusLists?.get(status);
    const validCachedNames =
      hit && this.statusListCurrent(cache, hit)
        ? await this.statusListValidNames(status, hit)
        : new Set<string>();
    if (
      hit &&
      hit.mtimeNs === before &&
      this.statusMtimeSettled(before, hit.scanTimeNs) &&
      this.statusListCurrent(cache, hit) &&
      validCachedNames.size === hit.byName.size
    ) {
      return this.cloneStatusList(hit);
    }
    const dir = statusDir(this.root, status);
    const names = await listMdFiles(dir);
    const byName = new Map<string, StatusListEntry>();
    const toRead: string[] = [];
    for (const name of names) {
      const prev = hit?.byName.get(name);
      const id = name.slice(0, -3);
      if (prev && validCachedNames.has(name) && prev.idGen === (cache.idGen.get(id) ?? 0)) {
        byName.set(name, prev);
      } else toRead.push(name);
    }
    await this.readStatusNames(status, dir, toRead, cache, byName);
    const ordered = new Map<string, StatusListEntry>();
    for (const name of names) {
      const entry = byName.get(name);
      if (entry) ordered.set(name, entry);
    }
    const after = await this.statusDirMtime(status);
    cache.statusLists ??= new Map();
    const scanTimeNs = BigInt(Date.now()) * 1_000_000n;
    for (const [name, entry] of ordered) {
      const key = `${status}/${name}`;
      const file = cache.files.get(key);
      if (file) entry.fingerprint = file;
    }
    cache.statusLists.set(status, {
      // A create or replace during the read would be missing from `names`. The next call
      // lists the directory again; the files already parsed stay in `ordered`.
      mtimeNs:
        after === before &&
        this.statusListCurrent(cache, { mtimeNs: after, scanTimeNs, byName: ordered })
          ? after
          : -1n,
      scanTimeNs,
      byName: ordered,
    });
    return this.cloneStatusList({ mtimeNs: after, scanTimeNs, byName: ordered });
  }

  /** Parsed `names` into `byName`. A write that lands during the read is read once more. */
  private async readStatusNames(
    status: Status,
    dir: string,
    names: readonly string[],
    cache: RootCache,
    byName: Map<string, StatusListEntry>,
  ): Promise<void> {
    let pending = names;
    for (let pass = 0; pass < 2 && pending.length > 0; pass++) {
      const beforeGen = pending.map((name) => cache.idGen.get(name.slice(0, -3)) ?? 0);
      const read = await mapPool(pending, READ_CONCURRENCY, (name) =>
        this.cachedTask(status, name, join(dir, name)),
      );
      const again: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const name = pending[i]!;
        const task = read[i];
        const id = name.slice(0, -3);
        if (!task) {
          byName.delete(name);
          continue;
        }
        const afterGen = cache.idGen.get(id) ?? 0;
        // `wrote` bumped the generation during the read. The bytes may be the old file.
        if (afterGen !== beforeGen[i]) {
          if (pass === 0) again.push(name);
          else byName.set(name, { idGen: beforeGen[i]!, task });
          continue;
        }
        byName.set(name, { idGen: afterGen, task });
      }
      pending = again;
    }
  }

  /** False when this process wrote an id after the cached parse. */
  private statusListCurrent(cache: RootCache, hit: StatusListCache): boolean {
    for (const [name, entry] of hit.byName) {
      if ((cache.idGen.get(name.slice(0, -3)) ?? 0) !== entry.idGen) return false;
    }
    return true;
  }

  private statusMtimeSettled(mtimeNs: bigint, scanTimeNs: bigint): boolean {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    return nowNs - mtimeNs > STATUS_MTIME_TICK_NS && nowNs - scanTimeNs > STATUS_MTIME_TICK_NS;
  }

  private async statusListValidNames(status: Status, hit: StatusListCache): Promise<Set<string>> {
    const dir = statusDir(this.root, status);
    const results = await mapPool([...hit.byName], READ_CONCURRENCY, async ([name, entry]) => {
      if (!entry.fingerprint) return [name, false] as const;
      try {
        taskStatCalls += 1;
        const current = await stat(join(dir, name), { bigint: true });
        const old = entry.fingerprint;
        return [
          name,
          current.mtimeNs === old.mtimeNs &&
            current.ctimeNs === old.ctimeNs &&
            current.ino === old.ino &&
            current.size === old.size,
        ] as const;
      } catch (err) {
        if (isNotFound(err)) return [name, false] as const;
        throw err;
      }
    });
    return new Set(results.filter(([, valid]) => valid).map(([name]) => name));
  }

  private cloneStatusList(hit: StatusListCache): Task[] {
    return [...hit.byName.values()].map((entry) => cloneTask(entry.task));
  }

  private async statusDirMtime(status: Status): Promise<bigint> {
    try {
      return (await stat(statusDir(this.root, status), { bigint: true })).mtimeNs;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return 0n;
    }
  }

  /** Read every task file in one status directory, skipping files that vanish. Unchanged files are served from the process cache. */
  private async listStatus(status: Status, names?: Set<string>): Promise<Task[]> {
    const dir = statusDir(this.root, status);
    const listed = await this.listStatusNames(status, names ?? new Set());
    const tasks = await mapPool(listed, READ_CONCURRENCY, (name) =>
      this.cachedTask(
        status,
        name,
        status === "running" ? join(dir, name, "task.md") : join(dir, name),
      ),
    );
    return tasks.filter((task): task is Task => task !== null);
  }

  /** The parsed file at `path`, from the cache when its filesystem identity and timestamps match. */
  private async cachedTask(status: Status, name: string, path: string): Promise<Task | null> {
    const cache = cacheFor(this.root);
    const key = `${status}/${name}`;
    const id = status === "running" ? name : name.slice(0, -3);
    let before;
    try {
      taskStatCalls += 1;
      before = await stat(path, { bigint: true });
    } catch (err) {
      if (isNotFound(err)) {
        cache.files.delete(key);
        return null;
      }
      throw err;
    }
    const hit = cache.files.get(key);
    if (
      hit &&
      hit.mtimeNs === before.mtimeNs &&
      hit.ctimeNs === before.ctimeNs &&
      hit.ino === before.ino &&
      hit.size === before.size
    ) {
      cache.files.delete(key);
      cache.files.set(key, hit);
      return cloneTask(hit.task);
    }
    const gen = cache.idGen.get(id) ?? 0;
    const task = await readTaskIfExists(path, status);
    if (!task) {
      cache.files.delete(key);
      return null;
    }
    let after;
    try {
      after = await stat(path, { bigint: true });
    } catch (err) {
      if (isNotFound(err)) return cloneTask(task);
      throw err;
    }
    if (
      after.mtimeNs === before.mtimeNs &&
      after.ctimeNs === before.ctimeNs &&
      after.ino === before.ino &&
      after.size === before.size &&
      (cache.idGen.get(id) ?? 0) === gen
    ) {
      cache.files.delete(key);
      cache.files.set(key, {
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs,
        ino: before.ino,
        size: before.size,
        task,
      });
      while (cache.files.size > MAX_CACHED_TASK_FILES) {
        const oldest = cache.files.keys().next().value;
        if (oldest === undefined) break;
        cache.files.delete(oldest);
      }
    }
    return cloneTask(task);
  }

  /** Drop cached files that the settled scan did not see. */
  private pruneFileCache(seen: Set<string>): void {
    const files = cacheFor(this.root).files;
    for (const key of files.keys()) if (!seen.has(key)) files.delete(key);
  }

  /**
   * This process just wrote `id`. Drop its cached parse so the next list cannot store a copy it
   * read before the write. `structure` is a create, move or delete: the status counts change.
   */
  private wrote(id: string, structure: boolean): void {
    const cache = cacheFor(this.root);
    cache.idGen.set(id, (cache.idGen.get(id) ?? 0) + 1);
    cache.files.delete(`running/${id}`);
    for (const status of ALL_STATUSES) {
      if (status !== "running") cache.files.delete(`${status}/${id}.md`);
    }
    // The flat listing must not keep serving this id. Dropping it also forces the next
    // listByStatus to look at the directory again when a rewrite left the mtime unchanged.
    if (cache.statusLists) {
      const name = `${id}.md`;
      for (const list of cache.statusLists.values()) {
        if (list.byName.delete(name)) list.mtimeNs = -1n;
      }
    }
    if (structure) {
      cache.structureGen += 1;
      cache.summary = undefined;
    }
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
        // The recorded agent of an interrupted run is written by recovery and cleared on requeue.
        if (disk.frontmatter.agentProcess) {
          task.frontmatter.agentProcess = disk.frontmatter.agentProcess;
        } else delete task.frontmatter.agentProcess;
        // Hierarchy keys are written only by hierarchy.ts through modify, so a copy read earlier
        // must not revert a move (and a key the disk lacks must not reappear from the copy).
        for (const key of ["epicId", "parentId"] as const) {
          if (disk.frontmatter[key] !== undefined) task.frontmatter[key] = disk.frontmatter[key];
          else delete task.frontmatter[key];
        }
      }
      await atomicWrite(located.path, serializeTask(task));
      this.wrote(id, false);
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
      this.wrote(id, false);
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
        this.wrote(id, false);
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
      this.wrote(id, false);
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
      this.wrote(id, false);
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
      this.wrote(task.frontmatter.id, true);
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
      moveCount.set(moveKey(this.root), (moveCount.get(moveKey(this.root)) ?? 0) + 1);
      this.wrote(id, true);
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
  async delete(id: string, opts: { refuseRunning?: boolean } = {}): Promise<void> {
    await this.lockTask(id, async () => {
      const located = await this.locate(id);
      if (!located) return;
      // Checked under the task lock, so a task the scheduler started a moment ago is not removed.
      if (opts.refuseRunning && located.status === "running") throw new TaskRunningError(id);
      if (located.status === "running") {
        await rmWorkingArea(workingAreaDir(this.root, id));
      } else {
        await rm(located.path, { force: true });
      }
      this.wrote(id, true);
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
