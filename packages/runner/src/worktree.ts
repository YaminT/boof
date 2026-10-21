import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "./exec.js";

const WORKTREE_ROOT = ".boof-runner-worktrees";
const BRANCH_PREFIX = "boof-runner/";

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

async function branchExists(workingDir: string, branch: string): Promise<boolean> {
  const res = await git(workingDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Branch checked out in the registered worktree at `path`, or null if none. */
async function registeredWorktreeBranch(workingDir: string, path: string): Promise<string | null> {
  const list = await git(workingDir, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return null;
  const target = await canonical(path);
  for (const entry of list.out.split(/\n\s*\n/)) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    for (const line of entry.split("\n")) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/"))
        branch = line.slice("branch refs/heads/".length);
    }
    if (wtPath && branch && (await canonical(wtPath)) === target) return branch;
  }
  return null;
}

/**
 * Create a per-task git worktree rooted at `workingDir`. Throws
 * NotAGitRepoError if the directory is not a git repo. Never deletes anything:
 * an existing task branch is reused, and an existing directory that is not a
 * registered worktree of that branch fails the call untouched.
 */
export async function createWorktree(workingDir: string, taskId: string): Promise<Worktree> {
  if (!(await isGitRepo(workingDir))) throw new NotAGitRepoError(workingDir);

  const branch = `${BRANCH_PREFIX}${taskId}`;
  const path = join(workingDir, WORKTREE_ROOT, taskId);
  const meta = await readMeta(workingDir, taskId);

  if (await pathExists(path)) {
    if ((await registeredWorktreeBranch(workingDir, path)) !== branch) {
      throw new Error(
        `Worktree path already exists and is not a registered worktree of ${branch}: ${path}. ` +
          `Refusing to touch it; move or remove it manually.`,
      );
    }
    const wt = meta ?? { path, branch, base: await mergeBase(workingDir, branch) };
    await writeMeta(workingDir, taskId, wt);
    return wt;
  }

  // Drops only registrations whose directory is gone; lets `worktree add` succeed on retry.
  await git(workingDir, ["worktree", "prune"]);

  let base: string;
  let add: { code: number | null; out: string; err: string };
  if (await branchExists(workingDir, branch)) {
    base = meta?.base ?? (await mergeBase(workingDir, branch));
    add = await git(workingDir, ["worktree", "add", path, branch]);
  } else {
    const headRes = await git(workingDir, ["rev-parse", "HEAD"]);
    base = headRes.code === 0 ? headRes.out : "HEAD";
    add = await git(workingDir, ["worktree", "add", "-b", branch, path, base]);
  }
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.err || add.out}`);
  }
  const wt = { path, branch, base };
  await writeMeta(workingDir, taskId, wt);
  return wt;
}

async function mergeBase(workingDir: string, branch: string): Promise<string> {
  const res = await git(workingDir, ["merge-base", "HEAD", branch]);
  if (res.code !== 0 || !res.out) {
    throw new Error(`git merge-base HEAD ${branch} failed: ${res.err || res.out}`);
  }
  return res.out;
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
 * Reuse the task's registered worktree if present, otherwise create one (reusing
 * an existing task branch). Reuse makes multi-run iterations cumulative: each
 * run sees the prior run's work in the same checkout (runs feature).
 */
export async function ensureWorktree(workingDir: string, taskId: string): Promise<Worktree> {
  if (!(await isGitRepo(workingDir))) throw new NotAGitRepoError(workingDir);
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

/**
 * Finish a task's worktree on final done. Commits uncommitted changes on the
 * task branch, then removes only the worktree directory (no --force). The
 * branch is never deleted. Never throws; returns log lines describing what
 * happened. On any failure the directory is kept.
 */
export async function finalizeWorktree(wt: Worktree, title: string): Promise<string[]> {
  const status = await git(wt.path, ["status", "--porcelain"]);
  if (status.code !== 0) {
    return [`Kept worktree ${wt.path}: git status failed: ${status.err || status.out}`];
  }
  if (status.out) {
    const add = await git(wt.path, ["add", "-A"]);
    const commit =
      add.code === 0 ? await git(wt.path, ["commit", "-m", `boof-runner: ${title}`]) : add;
    if (commit.code !== 0) {
      return [`Kept worktree ${wt.path}: commit failed: ${commit.err || commit.out}`];
    }
  }
  const remove = await git(wt.path, ["worktree", "remove", wt.path]);
  if (remove.code !== 0) {
    return [`Kept worktree ${wt.path}: git worktree remove failed: ${remove.err || remove.out}`];
  }
  return [`Removed worktree directory ${wt.path} (branch ${wt.branch} kept)`];
}

/** HEAD commit sha of a task branch, or "(unknown)". */
export async function branchHead(workingDir: string, branch: string): Promise<string> {
  const res = await git(workingDir, ["rev-parse", `refs/heads/${branch}`]);
  return res.code === 0 && res.out ? res.out : "(unknown)";
}

/**
 * Prune stale per-task worktrees on startup so crashed runs don't accumulate
 * (worktree-isolation spec). Only git bookkeeping for missing directories is
 * pruned; worktree directories and task branches are never removed.
 */
export async function pruneStaleWorktrees(workingDir: string): Promise<void> {
  if (!(await isGitRepo(workingDir))) return;
  await git(workingDir, ["worktree", "prune"]);
}
