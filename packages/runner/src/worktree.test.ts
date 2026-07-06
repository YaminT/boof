import { mkdtemp, rm, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "./exec.js";
import {
  cleanupWorktree,
  createWorktree,
  diffAgainstBase,
  ensureWorktree,
  isGitRepo,
  NotAGitRepoError,
} from "./worktree.js";

let repo: string;
let nonRepo: string;

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boof-claw-repo-"));
  nonRepo = await mkdtemp(join(tmpdir(), "boof-claw-nonrepo-"));
  const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@example.com"]);
  await g(["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "# base\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(nonRepo, { recursive: true, force: true });
});

describe("worktree isolation", () => {
  it("detects git vs non-git directories", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(nonRepo)).toBe(false);
  });

  it("refuses to create a worktree on a non-git dir", async () => {
    await expect(createWorktree(nonRepo, "t1")).rejects.toBeInstanceOf(NotAGitRepoError);
  });

  it("creates a worktree, diffs changes, and cleans up", async () => {
    const wt = await createWorktree(repo, "t1");
    expect(await exists(wt.path)).toBe(true);

    // Make a change inside the worktree.
    await writeFile(join(wt.path, "feature.txt"), "new feature\n");
    await execCommand("git", ["add", "."], { cwd: wt.path, timeoutMs: 10000 });
    await execCommand("git", ["commit", "-m", "feat"], { cwd: wt.path, timeoutMs: 10000 });

    const diff = await diffAgainstBase(wt);
    expect(diff).toContain("feature.txt");

    await cleanupWorktree(repo, wt);
    expect(await exists(wt.path)).toBe(false);
  });

  it("reuses an existing worktree (preserving prior work) across iterations", async () => {
    const first = await ensureWorktree(repo, "t3");
    await writeFile(join(first.path, "iter1.txt"), "from iteration 1\n");

    // A second ensure for the same task returns the SAME worktree with the file.
    const second = await ensureWorktree(repo, "t3");
    expect(second.path).toBe(first.path);
    expect(await exists(join(second.path, "iter1.txt"))).toBe(true);

    await cleanupWorktree(repo, second);
    expect(await exists(second.path)).toBe(false);
  });

  it("captures untracked files in the diff", async () => {
    const wt = await createWorktree(repo, "t2");
    await mkdir(join(wt.path, "sub"), { recursive: true });
    await writeFile(join(wt.path, "sub", "u.txt"), "untracked\n");
    const diff = await diffAgainstBase(wt);
    expect(diff).toContain("u.txt");
    await cleanupWorktree(repo, wt);
  });
});
