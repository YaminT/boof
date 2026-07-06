import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "./exec.js";

const WORKTREE_ROOT = ".boof-claw-worktrees";
const BRANCH_PREFIX = "boof-claw/";

function metaPath(workingDir: string, taskId: string): string {
  return join(workingDir, WORKTREE_ROOT, ".meta", `${taskId}.json`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface Worktree {
  /** Absolute path to the per-task worktree checkout. */
  path: string;
  /** Branch created for this task. */
  branch: string;
  /** Base revision the worktree was branched from (for diffing). */
  base: string;
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  const res = await execCommand("git", args, { cwd, timeoutMs: 30000 });
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim() };
}

/** True if `dir` is inside a git working tree (worktree-isolation spec). */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.out === "true";
}

export class NotAGitRepoError extends Error {
  constructor(public readonly dir: string) {
    super(
      `workingDirectory is not a git repository: ${dir}. ` +
        `Worktree-isolated runs require a git repo; refusing to run agents.`,
    );
    this.name = "NotAGitRepoError";
  }
}

/**
 * Create a per-task git worktree rooted at `workingDir`. Throws
 * NotAGitRepoError if the directory is not a git repo.
 */
export async function createWorktree(workingDir: string, taskId: string): Promise<Worktree> {
  if (!(await isGitRepo(workingDir))) throw new NotAGitRepoError(workingDir);

  const headRes = await git(workingDir, ["rev-parse", "HEAD"]);
  const base = headRes.code === 0 ? headRes.out : "HEAD";
  const branch = `${BRANCH_PREFIX}${taskId}`;
  const path = join(workingDir, WORKTREE_ROOT, taskId);

  // Remove any stale leftover for this task first (idempotent).
  await removeWorktree(workingDir, path, branch);

  const add = await git(workingDir, ["worktree", "add", "-b", branch, path, base]);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.err || add.out}`);
  }
  const wt = { path, branch, base };
  await writeMeta(workingDir, taskId, wt);
  return wt;
}

async function writeMeta(workingDir: string, taskId: string, wt: Worktree): Promise<void> {
  const mp = metaPath(workingDir, taskId);
  await mkdir(join(mp, ".."), { recursive: true });
  await writeFile(mp, JSON.stringify(wt), "utf8");
}

async function readMeta(workingDir: string, taskId: string): Promise<Worktree | null> {
  try {
    return JSON.parse(await readFile(metaPath(workingDir, taskId), "utf8")) as Worktree;
  } catch {
    return null;
  }
}

/**
 * Reuse an existing per-task worktree if one is still valid, otherwise create a
 * fresh one. Reuse makes multi-run iterations cumulative: each run sees the
 * prior run's work in the same checkout (runs feature).
 */
export async function ensureWorktree(workingDir: string, taskId: string): Promise<Worktree> {
  if (!(await isGitRepo(workingDir))) throw new NotAGitRepoError(workingDir);
  const meta = await readMeta(workingDir, taskId);
  if (meta && (await pathExists(meta.path))) {
    const branchOk = await git(workingDir, ["rev-parse", "--verify", meta.branch]);
    if (branchOk.code === 0) return meta;
  }
  return createWorktree(workingDir, taskId);
}

/** Diff the worktree against its base revision (reviewer input). */
export async function diffAgainstBase(wt: Worktree): Promise<string> {
  // Include both committed and uncommitted changes relative to base.
  const committed = await git(wt.path, ["diff", `${wt.base}`, "--stat"]);
  const full = await git(wt.path, ["--no-pager", "diff", wt.base]);
  const untracked = await git(wt.path, ["ls-files", "--others", "--exclude-standard"]);
  return [
    "## Summary\n" + committed.out,
    "## Diff\n" + full.out,
    untracked.out ? "## Untracked files\n" + untracked.out : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function removeWorktree(workingDir: string, path: string, branch: string): Promise<void> {
  await git(workingDir, ["worktree", "remove", "--force", path]);
  await rm(path, { recursive: true, force: true });
  await git(workingDir, ["branch", "-D", branch]);
}

/** Clean up a task's worktree on final-done/failed (and its meta sidecar). */
export async function cleanupWorktree(workingDir: string, wt: Worktree): Promise<void> {
  await removeWorktree(workingDir, wt.path, wt.branch);
  await git(workingDir, ["worktree", "prune"]);
  // Recover the task id from the branch (boof-claw/<id>) to drop the meta file.
  const taskId = wt.branch.startsWith(BRANCH_PREFIX) ? wt.branch.slice(BRANCH_PREFIX.length) : null;
  if (taskId) await rm(metaPath(workingDir, taskId), { force: true });
}

/**
 * Prune stale per-task worktrees on startup so crashed runs don't accumulate
 * (worktree-isolation spec). Removes the git bookkeeping; leftover directories
 * under .boof-claw-worktrees are best-effort removed.
 */
export async function pruneStaleWorktrees(workingDir: string): Promise<void> {
  if (!(await isGitRepo(workingDir))) return;
  await git(workingDir, ["worktree", "prune"]);
}
