import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "./atomic.js";

export interface ProcessLockOptions {
  /** Liveness probe for the holder's pid; default `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** How long to wait for another process's lock; default 30 000 ms. */
  lockTimeoutMs?: number;
  /** Poll interval while waiting for the lock; default 50 ms. */
  lockPollMs?: number;
  /** Our pid in the lock file; default `process.pid`. Tests use it to simulate other processes. */
  pid?: number;
  /**
   * Our boot id in the lock file; default {@link currentBootId}. `null` = this process has none.
   * A lock that names another boot is stale, but only when both sides have a boot id.
   */
  bootId?: string | null;
  /** Start time of a pid, default {@link processStartTicks}. Tests use it to simulate other processes. */
  startTicks?: (pid: number) => number | undefined;
  /** Test hook: runs while the takeover guard is held. */
  guardHeld?: () => Promise<void>;
}

const BOOT_UUID = /^[0-9a-f][0-9a-f-]{15,}$/i;
let bootId: string | undefined | null = null;

/**
 * The id of the current boot of this machine, a real per-boot uuid, or undefined when the system
 * has none we can read. A lock written before a reboot names a pid that may belong to another
 * process now; comparing boot ids tells it apart. Linux: `/proc/sys/kernel/random/boot_id`.
 * macOS: `sysctl -n kern.bootsessionuuid`. Nothing is derived from the clock: a boot time computed
 * from the uptime moves when the clock is stepped, and would make live locks look stale. Without
 * a uuid (Windows, a sandbox with /proc masked) a lock is judged by its pid alone, and a stale one
 * left by a crash plus a reboot with a reused pid has to be removed by hand (the error names it).
 */
export function currentBootId(): string | undefined {
  if (bootId !== null) return bootId;
  bootId = undefined;
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (BOOT_UUID.test(id)) return (bootId = id);
  } catch {
    // not Linux, or /proc is not readable
  }
  if (process.platform === "darwin") {
    try {
      const id = execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], {
        // Runs synchronously on a process's first lock: a hung sysctl must not block it for long.
        timeout: 2000,
        encoding: "utf8",
      }).trim();
      if (BOOT_UUID.test(id)) return (bootId = id);
    } catch {
      // no sysctl
    }
  }
  return bootId;
}

export function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Same-process callers queue here so a lock file naming our own pid can only be stale. */
const localQueues = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A takeover guard is held for microseconds; one older than this was left by a crash. A holder
 * paused for longer than this between its check and its `rm` could in theory remove a successor's
 * lock: that needs a stop of seconds inside a few microseconds of code, and is accepted.
 */
const TAKEOVER_GUARD_STALE_MS = 5000;

/**
 * A lock file that is empty or unreadable for this long was never completed (a crash between
 * creating and writing it, or a power loss with the data unflushed): it is stale. The link path
 * never shows a live writer's lock empty; on a file system without hard links the lock is created
 * and then written in place, and is empty for the instants in between (no fsync there either).
 * The window equals the default wait, so a writer would have to be stopped for that long to lose.
 */
const INCOMPLETE_LOCK_STALE_MS = 30_000;

/**
 * Run `fn` while holding the cross-process lock file `lock` (it holds the owner's pid and the
 * boot id, `<pid> <boot id>`; a file from before boot ids holds the pid alone).
 * Callers in this process queue in memory. A lock file is stale, and is taken over under an
 * exclusive `<lock>.takeover` guard so only one process removes it, when it names another boot
 * (a pid can be reused after a reboot), a dead pid, or our own pid while we are not holding it,
 * or when it is empty or unreadable and older than 30 s (never completed). A live
 * holder is waited for until `lockTimeoutMs`, then `timeoutError(holder, lock)` is thrown; a
 * fresh file that is not yet complete is treated as still being written.
 * Liveness is checked locally, so a lock left by a process on another host sharing the root
 * whose pid is unused here reads as dead and is taken over: data roots shared across hosts are
 * not supported.
 */
export async function withProcessLock<T>(
  lockPath: string,
  opts: ProcessLockOptions,
  fn: () => Promise<T>,
  timeoutError: (holder: string, lockPath: string) => Error,
): Promise<T> {
  const lock = await canonicalLockPath(lockPath);
  const pid = opts.pid ?? process.pid;
  const key = `${lock}\0${pid}`;
  const previous = localQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  localQueues.set(key, tail);
  await previous;
  try {
    await acquireFileLock(lock, pid, opts, timeoutError);
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

/**
 * The lock path with its directory resolved through symlinks (created if missing): one lock has
 * one name, so two spellings of a project path cannot run two critical sections at once.
 */
async function canonicalLockPath(lock: string): Promise<string> {
  const dir = dirname(lock);
  await mkdir(dir, { recursive: true });
  return join(await realpath(dir), basename(lock));
}

const LOCK_TEXT = /^(\d+)(?: (\S+))?(?: (\d+))?$/;

interface ParsedLock {
  pid: number;
  boot?: string;
  ticks?: number;
}

function parseLock(text: string): ParsedLock | undefined {
  const m = LOCK_TEXT.exec(text);
  if (!m || Number(m[1]) <= 0) return undefined;
  return {
    pid: Number(m[1]),
    ...(m[2] !== undefined ? { boot: m[2] } : {}),
    ...(m[3] !== undefined ? { ticks: Number(m[3]) } : {}),
  };
}

/**
 * Clock ticks since boot at which process `pid` started (field 22 of `/proc/<pid>/stat`), or
 * undefined where that is not readable (not Linux, no such process). With the boot id it names one
 * process for good: a pid reused inside a boot starts at another time.
 */
export function processStartTicks(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

function ourBoot(opts: ProcessLockOptions): string | undefined {
  return opts.bootId === undefined ? currentBootId() : (opts.bootId ?? undefined);
}

/** What we write: `<pid>`, plus ` <boot id>` and, with it, ` <start ticks>` where known. */
function lockContent(pid: number, opts: ProcessLockOptions): string {
  const boot = ourBoot(opts);
  if (!boot) return `${pid}\n`;
  const ticks = (opts.startTicks ?? processStartTicks)(pid);
  return ticks === undefined ? `${pid} ${boot}\n` : `${pid} ${boot} ${ticks}\n`;
}

/**
 * Is the lock `held` (parsed) left by a process that is gone? Another boot (both ids real uuids)
 * overrides a live pid; so does a start time that differs from the live pid's (same boot, pid
 * reused). A lock without those (old format, a legacy `t:` id, a process that could not read
 * them) is judged by the pid alone. `pid` is us: a lock naming our own pid that we do not hold is
 * a leftover from before a reboot.
 */
function isStale(held: ParsedLock, pid: number, opts: ProcessLockOptions): boolean {
  const boot = ourBoot(opts);
  // Both ids must be real uuids: ours too, or a clock-derived one could override a live pid.
  const ours = boot !== undefined && BOOT_UUID.test(boot) ? boot.toLowerCase() : undefined;
  const theirs =
    held.boot !== undefined && BOOT_UUID.test(held.boot) ? held.boot.toLowerCase() : undefined;
  const sameBootKnown = ours !== undefined && theirs === ours;
  const otherBoot = ours !== undefined && theirs !== undefined && theirs !== ours;
  if (otherBoot || held.pid === pid || !(opts.isProcessAlive ?? defaultAlive)(held.pid))
    return true;
  if (sameBootKnown && held.ticks !== undefined) {
    const now = (opts.startTicks ?? processStartTicks)(held.pid);
    if (now !== undefined && now !== held.ticks) return true;
  }
  return false;
}

type Attempt = { acquired: true } | { acquired: false; holder: string };

/**
 * One try at the lock file: create it exclusively; if it exists and is stale (see `isStale`, or
 * empty and old), take it over under the guard and try again; otherwise report the holder.
 */
async function attemptLock(lock: string, pid: number, opts: ProcessLockOptions): Promise<Attempt> {
  const guard = `${lock}.takeover`;
  await mkdir(dirname(lock), { recursive: true });
  for (;;) {
    try {
      // No fsync: a lock is stale after a crash anyway, and a file that comes back empty after a
      // power loss is taken over once it is old enough.
      await atomicWrite(lock, lockContent(pid, opts), { exclusive: true, sync: false });
      return { acquired: true };
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
    const seen = await stat(lock).catch(() => null);
    if (!seen) continue; // just released
    const held = parseLock(text);
    const stale = held
      ? isStale(held, pid, opts)
      : Date.now() - seen.mtimeMs > INCOMPLETE_LOCK_STALE_MS;
    if (stale && (await takeOver(lock, guard, text, seen, opts.guardHeld))) continue;
    return { acquired: false, holder: held ? String(held.pid) : text };
  }
}

async function acquireFileLock(
  lock: string,
  pid: number,
  opts: ProcessLockOptions,
  timeoutError: (holder: string, lockPath: string) => Error,
): Promise<void> {
  const deadline = Date.now() + (opts.lockTimeoutMs ?? 30_000);
  const pollMs = opts.lockPollMs ?? 50;
  for (;;) {
    const attempt = await attemptLock(lock, pid, opts);
    if (attempt.acquired) return;
    if (Date.now() >= deadline) throw timeoutError(attempt.holder, lock);
    await sleep(pollMs);
  }
}

export interface HeldProcessLock {
  /** Free the lock, if the file still names us (a takeover by another process is left alone). */
  release(): Promise<void>;
}

/** Locks this process holds through {@link tryAcquireProcessLock}, keyed `lock\0pid`. */
const heldHere = new Set<string>();

/**
 * Take the lock for as long as the process needs it (a runner guard), without waiting: null when
 * a live process, or this one, holds it. Staleness is judged as for {@link withProcessLock}. The
 * lock is not queued like `withProcessLock`'s: do not use the same file with both.
 */
export async function tryAcquireProcessLock(
  lockPath: string,
  opts: ProcessLockOptions = {},
): Promise<HeldProcessLock | null> {
  const lock = await canonicalLockPath(lockPath);
  const pid = opts.pid ?? process.pid;
  const key = `${lock}\0${pid}`;
  if (heldHere.has(key)) return null;
  heldHere.add(key); // before any await: concurrent callers in this process must not both try
  try {
    if (!(await attemptLock(lock, pid, opts)).acquired) {
      heldHere.delete(key);
      return null;
    }
  } catch (err) {
    heldHere.delete(key);
    throw err;
  }
  return {
    async release() {
      heldHere.delete(key);
      const text = await readFile(lock, "utf8").catch(() => "");
      if (parseLock(text.trim())?.pid === pid) await rm(lock, { force: true });
    },
  };
}

/**
 * Is a live process holding `lock`? Reads only: a stale file is neither removed nor taken over.
 * The holder may be this process (`pid` is then our own, held through {@link tryAcquireProcessLock}).
 */
export async function inspectProcessLock(
  lockPath: string,
  opts: ProcessLockOptions = {},
): Promise<{ held: false } | { held: true; pid: number }> {
  const lock = await realpath(dirname(lockPath)).then(
    (dir) => join(dir, basename(lockPath)),
    () => lockPath,
  );
  const pid = opts.pid ?? process.pid;
  const text = (await readFile(lock, "utf8").catch(() => "")).trim();
  const held = parseLock(text);
  if (!held) return { held: false };
  if (held.pid === pid)
    return heldHere.has(`${lock}\0${pid}`) ? { held: true, pid } : { held: false };
  return isStale(held, pid, opts) ? { held: false } : { held: true, pid: held.pid };
}

/** Remove the stale lock we read as `text` (file `seen`) while holding the takeover guard; false = guard busy. */
async function takeOver(
  lock: string,
  guard: string,
  text: string,
  seen: { ino: number; mtimeMs: number },
  guardHeld?: () => Promise<void>,
): Promise<boolean> {
  try {
    await atomicWrite(guard, `${process.pid}\n`, { exclusive: true, sync: false });
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
    await guardHeld?.();
    // The same file we judged stale, not another one with the same text: on a file system
    // without hard links a new lock is empty for an instant, and an empty one looks like the old.
    const again = await readFile(lock, "utf8").catch(() => null);
    const now = await stat(lock).catch(() => null);
    if (
      again !== null &&
      again.trim() === text &&
      now?.ino === seen.ino &&
      now.mtimeMs === seen.mtimeMs
    ) {
      await rm(lock, { force: true });
    }
  } finally {
    // Only our own guard: one older than the stale window may have been replaced by another
    // process's meanwhile.
    const owner = await readFile(guard, "utf8").catch(() => null);
    if (owner !== null && owner.trim() === String(process.pid)) await rm(guard, { force: true });
  }
  return true;
}
