import { execCommand } from "./exec.js";

/** Most untracked files listed or diffed for one review. */
export const MAX_UNTRACKED = 200;

const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]) {
  // --literal-pathspecs keeps file names from acting as pathspec magic.
  return execCommand(
    "git",
    ["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=off", ...args],
    { cwd, timeoutMs: GIT_TIMEOUT_MS },
  );
}

/** Untracked, not-ignored files of the worktree at `cwd` (at most MAX_UNTRACKED). */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const res = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (res.code !== 0) return [];
  return res.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED);
}

/**
 * Patch of one untracked file against nothing (`--no-index`, so no objects are written).
 * Binary files give git's one-line "Binary files … differ"; a symlink is shown as a link,
 * never followed. Exit 1 only means "differs".
 */
export async function untrackedPatch(cwd: string, path: string, context = 3): Promise<string> {
  const res = await git(cwd, [
    "diff",
    `-U${context}`,
    "--no-index",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    "/dev/null",
    path,
  ]);
  return res.stdout;
}
