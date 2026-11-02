import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname } from "node:path";
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
  /** Our boot id in the lock file; default {@link currentBootId}. A lock from another boot is stale. */
  bootId?: string;
}

let bootId: string | undefined;

/**
 * An id of the current boot of this machine, a token without spaces. A lock written before a
 * reboot names a pid that may belong to another process now; comparing boot ids tells it apart.
 * Linux: `/proc/sys/kernel/random/boot_id`. macOS: the `kern.boottime` seconds. Elsewhere
 * (Windows): the boot time derived from the uptime, which jitters, so ids of the `t:` form are
 * compared with a tolerance ({@link sameBoot}).
 */
export function currentBootId(): string {
  if (bootId) return bootId;
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (/^\S+$/.test(id)) return (bootId = id);
  } catch {
    // not Linux
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
      const sec = /sec\s*=\s*(\d+)/.exec(out)?.[1];
      if (sec) return (bootId = `t:${sec}`);
    } catch {
      // fall through to the uptime
    }
  }
  return (bootId = `t:${Math.round(Date.now() / 1000 - uptime())}`);
}

/** Do two boot ids name the same boot? `t:<seconds>` ids may differ by a little clock jitter. */
function sameBoot(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("t:") && b.startsWith("t:")) {
    return Math.abs(Number(a.slice(2)) - Number(b.slice(2))) <= 120;
  }
  return false;
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
 * creating and writing it, or a power loss with the data unflushed): it is stale.
 */
const INCOMPLETE_LOCK_STALE_MS = 5000;

/**
 * Run `fn` while holding the cross-process lock file `lock` (it holds the owner's pid and the
 * boot id, `<pid> <boot id>`; a file from before boot ids holds the pid alone).
 * Callers in this process queue in memory. A lock file is stale, and is taken over under an
 * exclusive `<lock>.takeover` guard so only one process removes it, when it names another boot
 * (a pid can be reused after a reboot), a dead pid, or our own pid while we are not holding it,
 * or when it is empty or unreadable and older than a few seconds (never completed). A live
 * holder is waited for until `lockTimeoutMs`, then `timeoutError(holder, lock)` is thrown; a
 * fresh file that is not yet complete is treated as still being written.
 * Liveness is checked locally, so a lock left by a process on another host sharing the root
 * whose pid is unused here reads as dead and is taken over: data roots shared across hosts are
 * not supported.
 */
export async function withProcessLock<T>(
  lock: string,
  opts: ProcessLockOptions,
  fn: () => Promise<T>,
  timeoutError: (holder: string, lockPath: string) => Error,
): Promise<T> {
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

async function acquireFileLock(
  lock: string,
  pid: number,
  opts: ProcessLockOptions,
  timeoutError: (holder: string, lockPath: string) => Error,
): Promise<void> {
  const alive = opts.isProcessAlive ?? defaultAlive;
  const boot = opts.bootId ?? currentBootId();
  const timeoutMs = opts.lockTimeoutMs ?? 30_000;
  const pollMs = opts.lockPollMs ?? 50;
  const guard = `${lock}.takeover`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // No fsync: a lock is stale after a crash anyway, and a file that comes back empty after a
      // power loss is taken over once it is old enough.
      await atomicWrite(lock, `${pid} ${boot}\n`, { exclusive: true, sync: false });
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
    const held = /^(\d+)(?: (\S+))?$/.exec(text);
    const holder = held ? Number(held[1]) : 0;
    const holderBoot = held?.[2];
    if (holder > 0) {
      const stale =
        (holderBoot !== undefined && !sameBoot(holderBoot, boot)) ||
        holder === pid ||
        !alive(holder);
      if (stale && (await takeOver(lock, guard, text))) continue;
    } else if (await olderThan(lock, INCOMPLETE_LOCK_STALE_MS)) {
      if (await takeOver(lock, guard, text)) continue;
    }
    if (Date.now() >= deadline) throw timeoutError(held ? String(holder) : text, lock);
    await sleep(pollMs);
  }
}

async function olderThan(path: string, ms: number): Promise<boolean> {
  const age = await stat(path).then(
    (st) => Date.now() - st.mtimeMs,
    () => 0,
  );
  return age > ms;
}

/** Remove the stale lock naming `text` while holding the takeover guard; false = guard busy. */
async function takeOver(lock: string, guard: string, text: string): Promise<boolean> {
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
    const again = await readFile(lock, "utf8").catch(() => null);
    if (again !== null && again.trim() === text) await rm(lock, { force: true });
  } finally {
    // Only our own guard: one older than the stale window may have been replaced by another
    // process's meanwhile.
    const owner = await readFile(guard, "utf8").catch(() => null);
    if (owner !== null && owner.trim() === String(process.pid)) await rm(guard, { force: true });
  }
  return true;
}
