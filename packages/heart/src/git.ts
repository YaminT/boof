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
  // An empty tree makes the attribute source independent of both the worktree and .git/info.
  "--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

/**
 * Assignments that blank every `filter.*` key and every `merge.*.driver` in a
 * `git config --null --get-regexp` listing. `git -c name=value` splits on the first `=`,
 * so a driver named `x=y` (`filter.x=y.clean`, `merge.x=y.driver`) cannot be cleared that way.
 * `GIT_CONFIG_KEY_<n>` can hold those keys. An empty command disables the driver; `required`
 * is set false so git does not demand a command that was just cleared. A driver created after
 * this read can still run.
 */
export function driverOverridesFromConfig(stdout: string): Array<{ key: string; value: string }> {
  const byKey = new Map<string, string>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const key = record.split("\n", 1)[0] ?? "";
    if (key.startsWith("filter.")) byKey.set(key, key.endsWith(".required") ? "false" : "");
    else if (/^merge\..+\.driver$/.test(key)) byKey.set(key, "");
  }
  return [...byKey.keys()].sort().map((key) => ({ key, value: byKey.get(key) ?? "" }));
}

function isNeutralisedDriverKey(key: string): boolean {
  return key.startsWith("filter.") || /^merge\..+\.driver$/.test(key);
}

/**
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` for `overrides`, keeping
 * any other pairs already in `base`. Inherited filter and merge-driver pairs are dropped so
 * they cannot put a command back.
 */
function envWithDriverOverrides(
  base: NodeJS.ProcessEnv,
  overrides: readonly { key: string; value: string }[],
): NodeJS.ProcessEnv {
  const kept: Array<{ key: string; value: string }> = [];
  const count = Number(base.GIT_CONFIG_COUNT);
  if (Number.isInteger(count) && count > 0) {
    for (let i = 0; i < count; i++) {
      const key = base[`GIT_CONFIG_KEY_${i}`];
      const value = base[`GIT_CONFIG_VALUE_${i}`];
      if (typeof key !== "string" || typeof value !== "string" || isNeutralisedDriverKey(key)) {
        continue;
      }
      kept.push({ key, value });
    }
  }
  const pairs = [...kept, ...overrides];
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach((pair, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = pair.key;
    env[`GIT_CONFIG_VALUE_${index}`] = pair.value;
  });
  return env;
}

function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

/** Timeout for the config read that finds filter and merge drivers. */
const DRIVER_LIST_TIMEOUT_MS = 10_000;

/** Matches every filter key and every custom merge driver. POSIX ERE, as git config expects. */
const DRIVER_LIST_PATTERN = "^filter\\.|^merge\\..*\\.driver$";

/**
 * The driver list could not be read. Blanking `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
 * would leave drivers in the repository's `.git/config` active, so the git command is refused.
 */
export class GitDriversUnreadError extends Error {
  constructor(detail: string) {
    super(`refusing git command: could not list filter and merge drivers (${detail})`);
    this.name = "GitDriversUnreadError";
  }
}

async function readDriverOverrides(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<Array<{ key: string; value: string }>> {
  const listTimeout = Math.min(DRIVER_LIST_TIMEOUT_MS, timeoutMs);
  let listed;
  try {
    listed = await execCommand(
      "git",
      [...GIT_HARDENING_ARGS, "config", "--null", "--get-regexp", DRIVER_LIST_PATTERN],
      { cwd, timeoutMs: listTimeout, env },
    );
  } catch (error) {
    throw new GitDriversUnreadError(error instanceof Error ? error.message : String(error));
  }
  if (listed.timedOut) {
    throw new GitDriversUnreadError(`timed out after ${listTimeout} ms`);
  }
  if (listed.code !== 0 && listed.code !== 1) {
    const detail = (listed.stderr || listed.stdout || `exit ${listed.code ?? "unknown"}`).trim();
    throw new GitDriversUnreadError(detail);
  }
  return driverOverridesFromConfig(listed.stdout);
}

/** Hardening args plus the environment that blanks filter and merge drivers, then `args`. */
export async function hardenedGitCommand(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = DRIVER_LIST_TIMEOUT_MS,
): Promise<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> {
  const callerEnv = gitEnv(env);
  const overrides = await readDriverOverrides(cwd, callerEnv, timeoutMs);
  return {
    args: [...GIT_HARDENING_ARGS, ...args],
    env:
      overrides.length === 0
        ? callerEnv
        : envWithDriverOverrides(callerEnv ?? process.env, overrides),
  };
}

/** Timeout for ordinary git calls. */
export const GIT_TIMEOUT_MS = 30_000;
export async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  const prepared = await hardenedGitCommand(cwd, args, env, timeoutMs);
  const res = await execCommand("git", prepared.args, {
    cwd,
    timeoutMs,
    env: prepared.env,
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
