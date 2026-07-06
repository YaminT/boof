import { readdir, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite, lockedAtomicWrite, readText, withFileLock } from "./atomic.js";
import { assertTransition } from "./lifecycle.js";
import { ALL_STATUSES, statusDir, taskFilePath, workingAreaDir } from "./paths.js";
import { nowIso } from "./runtime.js";
import type { Status } from "./schema.js";
import { parseTask, serializeTask, type Task } from "./task-file.js";

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

/**
 * File-backed task repository. The directory a task lives in is authoritative
 * for its status; on read we reconcile the frontmatter `status` to match the
 * location (task-lifecycle spec). All writes are atomic + locked.
 */
export class TaskStore {
  constructor(private readonly root: string) {}

  /** Ensure all status directories and commands/ exist. */
  async ensureDirs(): Promise<void> {
    for (const status of ALL_STATUSES) {
      await mkdir(statusDir(this.root, status), { recursive: true });
    }
    await mkdir(join(this.root, "commands"), { recursive: true });
  }

  /** Read and reconcile every task across all status directories. */
  async list(): Promise<Task[]> {
    const out: Task[] = [];
    for (const status of ALL_STATUSES) {
      const dir = statusDir(this.root, status);
      if (status === "running") {
        let subdirs: string[] = [];
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
          subdirs = [];
        }
        for (const id of subdirs) {
          const p = join(dir, id, "task.md");
          if (await exists(p)) out.push(await this.readReconciled(p, status));
        }
      } else {
        for (const name of await listMdFiles(dir)) {
          out.push(await this.readReconciled(join(dir, name), status));
        }
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

  /** Find a single task by id (searches all status dirs). */
  async get(id: string): Promise<Task | null> {
    const located = await this.locate(id);
    return located ? this.readReconciled(located.path, located.status) : null;
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
    task.frontmatter.updated = nowIso();
    const path = taskFilePath(this.root, task.frontmatter.status, task.frontmatter.id);
    await lockedAtomicWrite(path, serializeTask(task));
    return task;
  }

  /** Create a brand-new task file. */
  async create(task: Task): Promise<Task> {
    const now = nowIso();
    task.frontmatter.created = task.frontmatter.created || now;
    task.frontmatter.updated = now;
    const path = taskFilePath(this.root, task.frontmatter.status, task.frontmatter.id);
    await lockedAtomicWrite(path, serializeTask(task));
    return task;
  }

  /**
   * Transition a task to a new status: validate, write the file with the new
   * status, then remove the old location (write-then-move ordering). Returns
   * the moved task. `mutate` lets the caller adjust frontmatter/body atomically.
   */
  async transition(id: string, to: Status, mutate?: (t: Task) => void): Promise<Task> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Task not found: ${id}`);
    assertTransition(located.status, to);

    const task = await this.readReconciled(located.path, located.status);
    task.frontmatter.status = to;
    task.frontmatter.updated = nowIso();
    mutate?.(task);

    const destPath = taskFilePath(this.root, to, id);
    const fromStatus = located.status;
    const fromPath = located.path;

    // Lock on the destination path; use unguarded atomicWrite inside to avoid
    // re-entering the same-path lock (which would deadlock).
    await withFileLock(destPath, async () => {
      await mkdir(dirname(destPath), { recursive: true });
      await atomicWrite(destPath, serializeTask(task));
      if (fromPath !== destPath) {
        if (fromStatus === "running") {
          await rm(workingAreaDir(this.root, id), { recursive: true, force: true });
        } else {
          await rm(fromPath, { force: true });
        }
      }
    });
    return task;
  }

  /**
   * Permanently remove a task. For a `running` task the whole working-area
   * directory (ongoing/<id>/) is removed; every other status is a flat file.
   * No-op if the task is already gone.
   */
  async delete(id: string): Promise<void> {
    const located = await this.locate(id);
    if (!located) return;
    if (located.status === "running") {
      await rm(workingAreaDir(this.root, id), { recursive: true, force: true });
    } else {
      await rm(located.path, { force: true });
    }
  }

  /** Toggle the orthogonal skip flag without changing status/location. */
  async setSkip(id: string, skip: boolean): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.frontmatter.skip = skip;
    return this.save(task);
  }
}
