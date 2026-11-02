import { mkdir, readFile, rm, stat } from "node:fs/promises";
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

/** A takeover guard is held for microseconds; one older than this was left by a crash. */
const TAKEOVER_GUARD_STALE_MS = 5000;

/**
 * Run `fn` while holding the cross-process lock file `lock` (it holds the owner's pid).
 * Callers in this process queue in memory. A lock file whose pid is dead, or is our own pid
 * while we are not holding it (pid reuse after a reboot), is stale and is taken over under an
 * exclusive `<lock>.takeover` guard, so only one process removes it. A live holder is
 * waited for until `lockTimeoutMs`, then `timeoutError(holder)` is thrown; a holder value that
 * is not a positive integer is treated as still being written and is never taken over.
 * Liveness is checked locally, so a lock left by a process on another host sharing the root
 * whose pid is unused here reads as dead and is taken over: data roots shared across hosts are
 * not supported.
 */
export async function withProcessLock<T>(
  lock: string,
  opts: ProcessLockOptions,
  fn: () => Promise<T>,
  timeoutError: (holder: string) => Error,
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
  timeoutError: (holder: string) => Error,
): Promise<void> {
  const alive = opts.isProcessAlive ?? defaultAlive;
  const timeoutMs = opts.lockTimeoutMs ?? 30_000;
  const pollMs = opts.lockPollMs ?? 50;
  const guard = `${lock}.takeover`;
  await mkdir(dirname(lock), { recursive: true });
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
    if (Date.now() >= deadline) throw timeoutError(text);
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
