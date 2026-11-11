import { hardenedGitCommand } from "./git.js";
import { execCommand } from "./process.js";

/** Most untracked files listed or diffed for one review. */
export const MAX_UNTRACKED = 200;

const GIT_TIMEOUT_MS = 30_000;

export type UntrackedGitRunner = (
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

async function git(cwd: string, args: string[], runner?: UntrackedGitRunner) {
  if (runner) return runner(args);
  // --literal-pathspecs keeps file names from acting as pathspec magic.
  const prepared = await hardenedGitCommand(
    cwd,
    ["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=off", ...args],
    undefined,
    GIT_TIMEOUT_MS,
  );
  return execCommand("git", prepared.args, {
    launch: { kind: "direct" },
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: prepared.env,
  });
}

/** Untracked, not-ignored files of the worktree at `cwd` (at most MAX_UNTRACKED). */
export async function untrackedFiles(cwd: string, runner?: UntrackedGitRunner): Promise<string[]> {
  const res = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], runner);
  if (res.code !== 0) {
    console.error(`could not list untracked files in ${cwd}: ${res.stderr.trim() || res.code}`);
    return [];
  }
  return res.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED);
}

/**
 * Patch of one untracked file against nothing (`--no-index`, so no objects are written).
 * Binary files give git's one-line "Binary files … differ"; a symlink is shown as a link,
 * never followed. Exit 1 only means "differs".
 */
export async function untrackedPatch(
  cwd: string,
  path: string,
  context = 3,
  runner?: UntrackedGitRunner,
): Promise<string> {
  const res = await git(
    cwd,
    [
      "diff",
      `-U${context}`,
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      "/dev/null",
      path,
    ],
    runner,
  );
  return res.stdout;
}
