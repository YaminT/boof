import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { rename, open, rm, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * In-process per-path mutex. Both the web server and the runner import shared,
 * but each runs in its own process; within a process this serializes writers to
 * the same file. Cross-process safety comes from the atomic temp+rename below
 * (a rename is atomic on POSIX, so readers never observe a partial file).
 */
const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const mine = prev.then(() => gate);
  locks.set(path, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Free the entry when no one chained after us.
    if (locks.get(path) === mine) locks.delete(path);
  }
}

/** Number of paths currently in the lock map (test hook). */
export function fileLockCount(): number {
  return locks.size;
}

/** Directory fsync is refused on some platforms; those errors are not failures. */
const IGNORED_DIR_SYNC_CODES = new Set(["EINVAL", "EPERM", "ENOTSUP", "EISDIR"]);

/**
 * Atomically write `contents` to `path` (temp file + rename), creating dirs.
 * The temp file is fsynced before the rename and the directory after it, so a
 * power loss cannot leave a zero-length file behind.
 */
export async function atomicWrite(path: string, contents: string, mode?: number): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "w", mode ?? 0o666);
    try {
      await fh.writeFile(contents, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await syncDir(dir);
}

/**
 * fsync a directory. Directories cannot be opened (or fsynced) on every platform, e.g.
 * Windows: those failures skip the sync; anything else throws. `opener` is injectable for tests.
 */
export async function syncDir(dir: string, opener: typeof open = open): Promise<void> {
  let dh: FileHandle | undefined;
  try {
    dh = await opener(dir, "r");
    await dh.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !IGNORED_DIR_SYNC_CODES.has(code)) throw err;
  } finally {
    await dh?.close();
  }
}

/** Atomic write guarded by the per-path lock. */
export async function lockedAtomicWrite(
  path: string,
  contents: string,
  mode?: number,
): Promise<void> {
  await withFileLock(path, () => atomicWrite(path, contents, mode));
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
