import { mkdtemp, rm, writeFile, stat, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "./exec.js";
import {
  commitLeftovers,
  createWorktree as create,
  diffAgainstBase,
  discardWorktree,
  ensureWorktree as ensure,
  finalizeWorktree,
  isGitRepo,
  NotAGitRepoError,
  UnknownBaseRefError,
  type WorktreeOptions,
} from "./worktree.js";

let repo: string;
let nonRepo: string;

const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });

const rootOf = () => join(repo, ".boof-runner-worktrees");
const createWorktree = async (dir: string, id: string, opts?: Partial<WorktreeOptions>) =>
  (await create(dir, id, { root: rootOf(), ...opts })).worktree;
const ensureWorktree = async (dir: string, id: string, opts?: Partial<WorktreeOptions>) =>
  (await ensure(dir, id, { root: rootOf(), ...opts })).worktree;

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
    await expect(create(nonRepo, "t1", { root: rootOf() })).rejects.toBeInstanceOf(
      NotAGitRepoError,
    );
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
    await execCommand("git", ["add", "."], { cwd: first.path, timeoutMs: 10000 });
    await execCommand("git", ["commit", "-m", "prior"], { cwd: first.path, timeoutMs: 10000 });
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

  it("base: branch and sha start there; diff excludes earlier commits; wt.base is the sha", async () => {
    await g(["branch", "rel"]);
    await writeFile(join(repo, "later.txt"), "later\n");
    await g(["add", "."]);
    await g(["commit", "-m", "later"]);
    const relSha = (await g(["rev-parse", "rel"])).stdout.trim();
    const headSha = (await g(["rev-parse", "HEAD"])).stdout.trim();
    expect(relSha).not.toBe(headSha);

    const byBranch = await createWorktree(repo, "b1", { base: "rel" });
    expect(byBranch.base).toBe(relSha);
    expect(await exists(join(byBranch.path, "later.txt"))).toBe(false);
    await writeFile(join(byBranch.path, "mine.txt"), "mine\n");
    const diff = (await diffAgainstBase(byBranch)).text;
    expect(diff).toContain("mine.txt");
    expect(diff).not.toContain("later.txt");

    const bySha = await createWorktree(repo, "b2", { base: relSha });
    expect(bySha.base).toBe(relSha);
    const headOf = (await execCommand("git", ["rev-parse", "HEAD"], { cwd: bySha.path })).stdout;
    expect(headOf.trim()).toBe(relSha);

    const byDefault = await createWorktree(repo, "b3");
    expect(byDefault.base).toBe(headSha);
  });

  it("unknown base: throws UnknownBaseRefError and creates nothing", async () => {
    await expect(createWorktree(repo, "bad", { base: "nope" })).rejects.toBeInstanceOf(
      UnknownBaseRefError,
    );
    await expect(createWorktree(repo, "bad", { base: "nope" })).rejects.toThrow(
      "unknown base ref 'nope'",
    );
    await expect(createWorktree(repo, "bad", { base: "--all" })).rejects.toBeInstanceOf(
      UnknownBaseRefError,
    );
    expect(await exists(rootOf())).toBe(false);
    expect((await g(["branch", "--list", "boof-runner/*"])).stdout.trim()).toBe("");
  });

  it("a reused branch ignores base and reports baseIgnored", async () => {
    const first = await createWorktree(repo, "r1");
    await finalizeWorktree(repo, first, "t");
    await g(["branch", "other"]);
    const again = await create(repo, "r1", { root: rootOf(), base: "other" });
    expect(again.baseIgnored).toBe(true);
    expect(again.reused).toBe(true);
    expect(again.worktree.base).toBe(first.base);
    const fresh = await create(repo, "r2", { root: rootOf(), base: "other" });
    expect(fresh.baseIgnored).toBe(false);
    expect(fresh.reused).toBe(false);
  });

  it("root outside the repository holds the worktree and the sidecar", async () => {
    const outside = await mkdtemp(join(tmpdir(), "boof-runner-outside-"));
    try {
      const root = join(outside, "nested", "wt");
      const wt = await createWorktree(repo, "o1", { root });
      expect(wt.path).toBe(join(root, "o1"));
      expect(await exists(join(wt.path, "README.md"))).toBe(true);
      expect(await exists(join(root, ".meta", "o1.json"))).toBe(true);
      expect(await exists(rootOf())).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe("leftovers", () => {
    const w = (wt: { path: string }, args: string[]) =>
      execCommand("git", args, { cwd: wt.path, timeoutMs: 15000 });

    it("commitLeftovers leaves the task branch and worktree untouched", async () => {
      const wt = await createWorktree(repo, "l1");
      await writeFile(join(wt.path, "tracked.txt"), "t\n");
      await w(wt, ["add", "tracked.txt"]);
      await w(wt, ["commit", "-m", "deliberate"]);
      const head = (await g(["rev-parse", wt.branch])).stdout.trim();
      await writeFile(join(wt.path, "README.md"), "# edited\n");
      await mkdir(join(wt.path, "scratch"), { recursive: true });
      await writeFile(join(wt.path, "scratch", "n.txt"), "n\n");
      await mkdir(join(wt.path, "nested-repo"), { recursive: true });
      await w({ path: join(wt.path, "nested-repo") }, ["init", "-b", "main"]);
      await writeFile(join(wt.path, "nested-repo", "f"), "f\n");
      await w({ path: join(wt.path, "nested-repo") }, ["add", "."]);
      await w({ path: join(wt.path, "nested-repo") }, [
        "-c",
        "user.name=x",
        "-c",
        "user.email=x@y",
        "commit",
        "-m",
        "n",
      ]);
      const statusBefore = (await w(wt, ["status", "--porcelain"])).stdout;

      const left = await commitLeftovers(repo, wt, "title");
      expect(left?.branch).toBe("boof-runner/l1--leftovers");
      expect((await g(["rev-parse", wt.branch])).stdout.trim()).toBe(head);
      expect((await w(wt, ["status", "--porcelain"])).stdout).toBe(statusBefore);
      expect((await w(wt, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
      expect((await g(["rev-parse", `${left!.sha}^`])).stdout.trim()).toBe(head);
      const files = (await g(["ls-tree", "-r", "--name-only", left!.sha])).stdout;
      expect(files).toContain("scratch/n.txt");
      expect(files).toContain("tracked.txt");
      expect((await g(["show", `${left!.sha}:README.md`])).stdout).toBe("# edited\n");
      expect((await g(["log", "-1", "--format=%s", left!.sha])).stdout.trim()).toBe(
        "boof-runner leftovers: title",
      );

      // A second snapshot keeps the first as a parent.
      await writeFile(join(wt.path, "more.txt"), "m\n");
      const second = await commitLeftovers(repo, wt, "title");
      const parents = (await g(["rev-list", "--parents", "-n", "1", second!.sha])).stdout
        .trim()
        .split(" ");
      expect(parents.slice(1)).toEqual([head, left!.sha]);
    });

    it("a clean tree has no leftovers", async () => {
      const wt = await createWorktree(repo, "l2");
      expect(await commitLeftovers(repo, wt, "t")).toBeNull();
      expect((await g(["branch", "--list", "*--leftovers"])).stdout.trim()).toBe("");
    });

    it("an empty nested repository does not block the snapshot", async () => {
      const wt = await createWorktree(repo, "l3");
      await mkdir(join(wt.path, "fresh"), { recursive: true });
      await w({ path: join(wt.path, "fresh") }, ["init", "-b", "main"]);
      await writeFile(join(wt.path, "other.txt"), "o\n");
      const left = await commitLeftovers(repo, wt, "t");
      const files = (await g(["ls-tree", "-r", "--name-only", left!.sha])).stdout;
      expect(files).toContain("other.txt");
    });
  });

  describe("nested repositories are never silently deleted", () => {
    const nested = async (wt: { path: string }, name: string, commit: boolean) => {
      const dir = join(wt.path, name);
      await mkdir(dir, { recursive: true });
      const run = (args: string[]) => execCommand("git", args, { cwd: dir, timeoutMs: 15000 });
      await run(["init", "-b", "main"]);
      await writeFile(join(dir, "f.txt"), "f\n");
      if (commit) {
        await run(["add", "."]);
        await run(["-c", "user.name=x", "-c", "user.email=x@y", "commit", "-m", "n"]);
        await writeFile(join(dir, "uncommitted.txt"), "u\n");
      }
    };

    it("keep-branch keeps the directory when a nested repo has no commit", async () => {
      const wt = await createWorktree(repo, "n1");
      await nested(wt, "fresh", false);
      const lines = (await finalizeWorktree(repo, wt, "t")).join("\n");
      expect(await exists(join(wt.path, "fresh", "f.txt"))).toBe(true);
      expect(lines).toContain(`Kept worktree ${wt.path}: nested git repositories`);
      expect(lines).toContain("fresh");
      expect(lines).not.toContain("Removed worktree directory");
    });

    it("keep-branch keeps the directory when a nested repo is only a gitlink", async () => {
      const wt = await createWorktree(repo, "n2");
      await nested(wt, "withcommit", true);
      const lines = (await finalizeWorktree(repo, wt, "t")).join("\n");
      expect(await exists(join(wt.path, "withcommit", "uncommitted.txt"))).toBe(true);
      expect(lines).toContain("nested git repositories");
      expect(lines).toContain("withcommit");
    });

    it("commitLeftovers reports the unsaved paths", async () => {
      const wt = await createWorktree(repo, "n3");
      await nested(wt, "fresh", false);
      await nested(wt, "withcommit", true);
      const left = await commitLeftovers(repo, wt, "t");
      expect([...left!.unsaved].sort()).toEqual(["fresh", "withcommit"]);
    });
  });

  describe("retention policies", () => {
    const branchExists = async (b: string) =>
      (await g(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0;

    it("keep-branch (default): removes the directory, keeps the branch, never commits on it", async () => {
      const wt = await createWorktree(repo, "p1");
      const head = (await g(["rev-parse", wt.branch])).stdout.trim();
      await writeFile(join(wt.path, "x.txt"), "x\n");
      const lines = await finalizeWorktree(repo, wt, "t");
      expect(lines.join("\n")).toContain("Leftovers committed to boof-runner/p1--leftovers at");
      expect(await exists(wt.path)).toBe(false);
      expect((await g(["rev-parse", wt.branch])).stdout.trim()).toBe(head);
      expect(await branchExists("boof-runner/p1--leftovers")).toBe(true);
    });

    it("keep: leaves the directory and its files", async () => {
      const wt = await createWorktree(repo, "p2");
      await writeFile(join(wt.path, "x.txt"), "x\n");
      await finalizeWorktree(repo, wt, "t", "keep");
      expect(await exists(join(wt.path, "x.txt"))).toBe(true);
      expect(await branchExists("boof-runner/p2--leftovers")).toBe(true);
      expect(await branchExists(wt.branch)).toBe(true);
    });

    it("delete: removes directory and both branches and warns loudly", async () => {
      const wt = await createWorktree(repo, "p3");
      await writeFile(join(wt.path, "x.txt"), "x\n");
      await commitLeftovers(repo, wt, "t");
      const lines = await finalizeWorktree(repo, wt, "t", "delete");
      expect(lines.join("\n")).toContain("WARNING: DELETED task work");
      expect(await exists(wt.path)).toBe(false);
      expect(await branchExists(wt.branch)).toBe(false);
      expect(await branchExists("boof-runner/p3--leftovers")).toBe(false);
    });

    it("discardWorktree deletes a failed task's work and warns loudly", async () => {
      const wt = await createWorktree(repo, "p4");
      await writeFile(join(wt.path, "x.txt"), "x\n");
      const lines = await discardWorktree(repo, wt);
      expect(lines.join("\n")).toContain("WARNING: DELETED task work");
      expect(lines.join("\n")).toContain("onFailure=delete");
      expect(await exists(wt.path)).toBe(false);
      expect(await branchExists(wt.branch)).toBe(false);
    });
  });
});
