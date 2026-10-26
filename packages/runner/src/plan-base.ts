/**
 * Git helpers for the base of a plan task: does a branch exist, is one branch contained in
 * another, and an integration branch that merges several dependency branches. Nothing here
 * touches the user's checked-out branch, index or working tree: merges run in a temporary
 * detached worktree that is removed afterwards.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "./exec.js";

const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[]) {
  try {
    return await execCommand("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/** True when `branch` exists as a local branch of the repository. */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const res = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res !== null && res.code === 0 && res.stdout.trim() !== "";
}

/** True when `ancestor` is reachable from `descendant` (`git merge-base --is-ancestor`). */
export async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const res = await git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return res !== null && res.code === 0;
}

export type IntegrationResult = { ok: true; branch: string } | { ok: false; reason: string };

/**
 * Create `branch` as the merge of `parents` (the first parent is the start, the rest are merged
 * in order). Fails without leaving a branch behind when a merge conflicts or git fails.
 */
export async function createIntegrationBranch(
  repoRoot: string,
  branch: string,
  parents: string[],
): Promise<IntegrationResult> {
  if (parents.length < 2) return { ok: false, reason: "need at least two branches to merge" };
  if (await branchExists(repoRoot, branch)) return { ok: true, branch };
  const dir = await mkdtemp(join(tmpdir(), "boof-integration-"));
  const tree = join(dir, "wt");
  try {
    const add = await git(repoRoot, ["worktree", "add", "--detach", tree, parents[0]!]);
    if (!add || add.code !== 0) {
      return { ok: false, reason: `git worktree add failed: ${add?.stderr.trim() ?? "no git"}` };
    }
    for (const parent of parents.slice(1)) {
      const merge = await git(tree, [
        "-c",
        "user.name=boof-runner",
        "-c",
        "user.email=boof-runner@localhost",
        "-c",
        "commit.gpgsign=false",
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `boof-runner: integrate ${parent}`,
        parent,
      ]);
      if (!merge || merge.code !== 0) {
        await git(tree, ["merge", "--abort"]);
        const detail = (merge?.stdout ?? "").split("\n").find((l) => l.includes("CONFLICT"));
        return { ok: false, reason: `merging ${parent} conflicts${detail ? `: ${detail}` : ""}` };
      }
    }
    const head = await git(tree, ["rev-parse", "HEAD"]);
    const sha = head?.stdout.trim();
    if (!head || head.code !== 0 || !sha) return { ok: false, reason: "git rev-parse HEAD failed" };
    const ref = await git(repoRoot, ["update-ref", `refs/heads/${branch}`, sha]);
    if (!ref || ref.code !== 0) {
      return { ok: false, reason: `git update-ref failed: ${ref?.stderr.trim() ?? "no git"}` };
    }
    return { ok: true, branch };
  } finally {
    await git(repoRoot, ["worktree", "remove", "--force", tree]);
    await git(repoRoot, ["worktree", "prune"]);
    await rm(dir, { recursive: true, force: true });
  }
}
