import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execCommand } from "./process.js";

const LEFTOVERS_SUFFIX = "--leftovers";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Leading arguments for every git call the server makes in a repository an agent can write to.
 * The agent can set `core.fsmonitor` or install hooks in the shared `.git`; without this the
 * server's next `git status` would run them with the server's environment. Command-line `-c`
 * overrides repository config.
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];

/**
 * `-c` overrides that blank every clean/smudge/process filter currently in git config.
 * An empty command disables the filter. Names come from a config read taken just before the
 * real command; a driver created after that read can still run.
 */
export function filterOverrideArgsFromConfig(stdout: string): string[] {
  const names = new Set<string>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const key = record.split("\n", 1)[0] ?? "";
    const match = /^filter\.([^\s=]+)\.(clean|smudge|process|required)$/.exec(key);
    if (match?.[1]) names.add(match[1]);
  }
  const args: string[] = [];
  for (const name of [...names].sort()) {
    args.push(
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    );
  }
  return args;
}

function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

/** Timeout for the config read that finds filter drivers. */
const FILTER_LIST_TIMEOUT_MS = 10_000;

/** Blank every filter driver visible in this repository's config, including global config. */
export async function gitFilterOverrideArgs(
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  try {
    const listed = await execCommand(
      "git",
      [...GIT_HARDENING_ARGS, "config", "--null", "--get-regexp", "^filter\\."],
      { cwd, timeoutMs: FILTER_LIST_TIMEOUT_MS, env: gitEnv(env) },
    );
    if (listed.timedOut || (listed.code !== 0 && listed.code !== 1)) return [];
    return filterOverrideArgsFromConfig(listed.stdout);
  } catch {
    return [];
  }
}

/** Hardening plus filter overrides plus `args`, for every server-run git command. */
export async function hardenedGitArgs(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  return [...GIT_HARDENING_ARGS, ...(await gitFilterOverrideArgs(cwd, env)), ...args];
}

/** Timeout for ordinary git calls. */
export const GIT_TIMEOUT_MS = 30_000;
export async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  const res = await execCommand("git", await hardenedGitArgs(cwd, args, env), {
    cwd,
    timeoutMs,
    env: gitEnv(env),
  });
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim(), timedOut: res.timedOut };
}

/** True if `dir` is inside a git working tree (worktree-isolation spec). */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.out === "true";
}

/**
 * Realpath of the git common dir of `dir` (`rev-parse --git-common-dir`): the same for a
 * repository's main checkout, its subdirectories and its linked worktrees; null when git fails.
 */
export async function repoCommonDir(dir: string): Promise<string | null> {
  // No `--path-format=absolute` (git < 2.31 echoes it): the printed path may be relative to `dir`.
  const res = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (res.code !== 0 || !res.out) return null;
  const abs = resolve(dir, res.out);
  return realpath(abs).catch(() => abs);
}

export interface InitGitRepoOptions {
  /** Per git call; a hung git must not hold the project-create lock. Defaults to GIT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra environment for the git calls (tests isolate HOME / GIT_CONFIG_GLOBAL, or fake git). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Make `dir` a git repository with at least one commit, so worktree isolation works: `git init`
 * when it is not a repository, then an empty "Initial commit" when HEAD is unborn. The commit
 * falls back to its own identity where git has none, and never signs (per invocation; the user's git config is not touched).
 * Throws when a git call fails or times out (the process is killed).
 */
export async function initGitRepo(dir: string, opts: InitGitRepoOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const run = async (args: string[]) => {
    const res = await git(dir, args, { GIT_TERMINAL_PROMPT: "0", ...opts.env }, timeoutMs);
    if (res.timedOut) {
      throw new Error(`git ${args[0]} timed out after ${timeoutMs} ms in ${dir}`);
    }
    return res;
  };
  // `dir` itself must be a repository: inside a parent's work tree, git would use the parent.
  if (!(await pathExists(join(dir, ".git")))) {
    const init = await run(["init", "-q"]);
    if (init.code !== 0) throw new Error(`git init failed in ${dir}: ${init.err}`);
  }
  if ((await run(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) return;
  // The boof identity is only a fallback for what the owner's git config lacks.
  const identity: string[] = [];
  if (!(await run(["config", "user.name"])).out) identity.push("-c", "user.name=Boof Runner");
  if (!(await run(["config", "user.email"])).out) {
    identity.push("-c", "user.email=boof-runner@localhost");
  }
  const commit = await run([
    ...identity,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "Initial commit",
  ]);
  if (commit.code !== 0) throw new Error(`git init failed in ${dir}: ${commit.err}`);
}

/** Branch checked out in `dir` (git symbolic-ref); null when detached, not a repo or git fails. */
export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const res = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return res.code === 0 && res.out ? res.out : null;
  } catch {
    return null;
  }
}

/**
 * True when `refs/heads/<branch>` exists in the repository of `workingDir`. Not `plan-base`'s
 * `branchExists` (a different export: it takes a repo root, trims, and returns false on a failed
 * git call), which is why this one has its own name.
 */
export async function localBranchExists(workingDir: string, branch: string): Promise<boolean> {
  const res = await git(workingDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

export async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Branch checked out in the registered worktree at `path`, or null if none. */
export async function registeredWorktreeBranch(
  workingDir: string,
  path: string,
): Promise<string | null> {
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

/** Side branch holding a task's uncommitted leftovers. */
export function leftoversBranch(wt: { branch: string }): string {
  return `${wt.branch}${LEFTOVERS_SUFFIX}`;
}

/** HEAD commit sha of a task branch, or "(unknown)". */
export async function branchHead(workingDir: string, branch: string): Promise<string> {
  const res = await git(workingDir, ["rev-parse", `refs/heads/${branch}`]);
  return res.code === 0 && res.out ? res.out : "(unknown)";
}

/**
 * Prune stale per-task worktrees on startup so crashed runs don't accumulate
 * (worktree-isolation spec). Only git bookkeeping for missing directories is
 * pruned; worktree directories and task branches are never removed. Rejects when git exits
 * non-zero or times out, so callers can log it.
 */
export async function pruneStaleWorktrees(workingDir: string): Promise<void> {
  if (!(await isGitRepo(workingDir))) return;
  const res = await git(workingDir, ["worktree", "prune"]);
  if (res.timedOut) throw new Error(`git worktree prune timed out in ${workingDir}`);
  if (res.code !== 0) {
    throw new Error(
      `git worktree prune failed in ${workingDir} (exit ${res.code}): ${res.err || res.out}`,
    );
  }
}
