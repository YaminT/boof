import { randomBytes } from "node:crypto";
import { rename, writeFile, mkdir, readFile } from "node:fs/promises";
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
  const next = new Promise<void>((res) => (release = res));
  locks.set(
    path,
    prev.then(() => next),
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up if no one chained after us.
    if (locks.get(path) === next.then(() => {})) locks.delete(path);
  }
}

/** Atomically write `contents` to `path` (temp file + rename), creating dirs. */
export async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

/** Atomic write guarded by the per-path lock. */
export async function lockedAtomicWrite(path: string, contents: string): Promise<void> {
  await withFileLock(path, () => atomicWrite(path, contents));
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
