import { mkdtemp, rm, writeFile, stat, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "./exec.js";
import {
  createWorktree,
  diffAgainstBase,
  ensureWorktree,
  finalizeWorktree,
  isGitRepo,
  NotAGitRepoError,
} from "./worktree.js";

let repo: string;
let nonRepo: string;

const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boof-runner-repo-"));
  nonRepo = await mkdtemp(join(tmpdir(), "boof-runner-nonrepo-"));
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

    const diff = (await diffAgainstBase(wt)).text;
    expect(diff).toContain("feature.txt");

    expect(await finalizeWorktree(repo, wt, "t")).toEqual([expect.stringContaining("Removed")]);
    expect(await exists(wt.path)).toBe(false);
    expect((await g(["rev-parse", "--verify", "refs/heads/boof-runner/t1"])).code).toBe(0);
  });

  it("reuses an existing worktree (preserving prior work) across iterations", async () => {
    const first = await ensureWorktree(repo, "t3");
    await writeFile(join(first.path, "iter1.txt"), "from iteration 1\n");

    // A second ensure for the same task returns the SAME worktree with the file.
    const second = await ensureWorktree(repo, "t3");
    expect(second.path).toBe(first.path);
    expect(await exists(join(second.path, "iter1.txt"))).toBe(true);

    await finalizeWorktree(repo, second, "t");
    expect(await exists(second.path)).toBe(false);
    expect((await g(["rev-parse", "--verify", "refs/heads/boof-runner/t3"])).code).toBe(0);
  });

  it("captures untracked files in the diff", async () => {
    const wt = await createWorktree(repo, "t2");
    await mkdir(join(wt.path, "sub"), { recursive: true });
    await writeFile(join(wt.path, "sub", "u.txt"), "untracked\n");
    const diff = (await diffAgainstBase(wt)).text;
    expect(diff).toContain("u.txt");
    await finalizeWorktree(repo, wt, "t");
  });

  it("inlines the full diff when under the byte limit", async () => {
    const wt = await createWorktree(repo, "cap-under");
    await writeFile(join(wt.path, "small.txt"), "tiny\n");
    await g(["-C", wt.path, "add", "."]);
    const res = await diffAgainstBase(wt, 100000);
    expect(res.capped).toBe(false);
    expect(res.text).toContain("## Diff");
    expect(res.text).toContain("+tiny");
  });

  it("caps an over-limit diff to --stat plus a note with the base sha", async () => {
    const wt = await createWorktree(repo, "cap-over");
    await writeFile(join(wt.path, "big.txt"), "x".repeat(2000) + "\n");
    await g(["-C", wt.path, "add", "."]);
    await writeFile(join(wt.path, "loose.txt"), "untracked\n");
    const res = await diffAgainstBase(wt, 100);
    const sha = (await g(["rev-parse", wt.base])).stdout.trim();
    expect(res.capped).toBe(true);
    expect(res.baseSha).toBe(sha);
    expect(res.bytes).toBeGreaterThan(100);
    expect(res.text).toContain("## Summary");
    expect(res.text).toContain("big.txt");
    expect(res.text).toContain("loose.txt");
    expect(res.text).toContain("exceeds the inline limit");
    expect(res.text).toContain(`git diff ${sha} -- <path>`);
    expect(res.text).not.toContain("## Diff");
    expect(res.text).not.toContain("xxxxxxxxxx");
  });

  it("re-creating a task whose branch exists reuses it and keeps its commits", async () => {
    const first = await createWorktree(repo, "t4");
    await writeFile(join(first.path, "prior.txt"), "prior\n");
    await finalizeWorktree(repo, first, "prior work");
    const sha = (await g(["rev-parse", "refs/heads/boof-runner/t4"])).stdout.trim();
    expect(await exists(first.path)).toBe(false);

    const again = await createWorktree(repo, "t4");
    expect(await exists(join(again.path, "prior.txt"))).toBe(true);
    expect(again.base).toBe(first.base);
    expect((await g(["rev-parse", "refs/heads/boof-runner/t4"])).stdout.trim()).toBe(sha);
    await finalizeWorktree(repo, again, "prior work");

    // Without the meta sidecar the base falls back to the merge-base.
    await rm(join(repo, ".boof-runner-worktrees", ".meta"), { recursive: true, force: true });
    const third = await createWorktree(repo, "t4");
    const mb = (await g(["merge-base", "HEAD", "boof-runner/t4"])).stdout.trim();
    expect(third.base).toBe(mb);
    expect(await exists(join(third.path, "prior.txt"))).toBe(true);
    expect((await g(["rev-parse", "refs/heads/boof-runner/t4"])).stdout.trim()).toBe(sha);
  });

  it("re-creating while the worktree is still present keeps uncommitted work", async () => {
    const first = await createWorktree(repo, "t6");
    await writeFile(join(first.path, "wip.txt"), "wip\n");
    const second = await createWorktree(repo, "t6");
    expect(second.path).toBe(first.path);
    expect(await exists(join(second.path, "wip.txt"))).toBe(true);
  });

  it("fails clearly on an unregistered directory at the worktree path, leaving it untouched", async () => {
    const dir = join(repo, ".boof-runner-worktrees", "t5");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "sentinel");

    await expect(createWorktree(repo, "t5")).rejects.toThrow(dir);
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("sentinel");
  });

  it("finalize keeps a worktree whose HEAD left the task branch", async () => {
    const wt = await createWorktree(repo, "t7");
    const sha = (await g(["rev-parse", "refs/heads/boof-runner/t7"])).stdout.trim();
    const w = (args: string[]) => execCommand("git", args, { cwd: wt.path, timeoutMs: 15000 });
    await w(["checkout", "--detach"]);
    await writeFile(join(wt.path, "detached.txt"), "x\n");
    await w(["add", "-A"]);
    await w(["commit", "-m", "detached work"]);
    await writeFile(join(wt.path, "leftover.txt"), "y\n");

    const lines = await finalizeWorktree(repo, wt, "t");
    expect(lines.join("\n")).toContain("HEAD is not on");
    expect(await exists(join(wt.path, "detached.txt"))).toBe(true);
    expect(await exists(join(wt.path, "leftover.txt"))).toBe(true);
    expect((await g(["rev-parse", "refs/heads/boof-runner/t7"])).stdout.trim()).toBe(sha);
  });
});
