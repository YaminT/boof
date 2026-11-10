import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  git,
  initGitRepo,
  isGitRepo,
  leftoversBranch,
  pruneStaleWorktrees,
  registeredWorktreeBranch,
  repoCommonDir,
} from "./git.js";
import { execCommand } from "./process.js";
import { taskDiff } from "./task-diff.js";
import { untrackedFiles } from "./untracked-diff.js";

let repo: string;
let nonRepo: string;

const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });

/** A linked worktree with its own branch, made with plain git (no Runner lifecycle code). */
const addWorktree = async (name: string) => {
  const path = join(repo, ".wts", name);
  await g(["worktree", "add", "-q", "-b", `boof-runner/${name}`, path]);
  return { path, branch: `boof-runner/${name}` };
};

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
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(nonRepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("git queries", () => {
  it("detects git vs non-git directories", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(nonRepo)).toBe(false);
  });

  it("pruneStaleWorktrees drops a missing worktree registration and keeps a live one", async () => {
    const live = await addWorktree("live");
    const gone = await addWorktree("gone");
    await rm(gone.path, { recursive: true, force: true });
    await pruneStaleWorktrees(repo);
    const list = (await g(["worktree", "list", "--porcelain"])).stdout;
    expect(list).toContain(live.path);
    expect(list).not.toContain(gone.path);
    expect(await exists(live.path)).toBe(true);
    await expect(pruneStaleWorktrees(nonRepo)).resolves.toBeUndefined();
  });

  it("pruneStaleWorktrees rejects when git exits non-zero", async () => {
    // A git shim on PATH that fails `worktree prune` and forwards everything else.
    const shim = await mkdtemp(join(tmpdir(), "boof-gitshim-"));
    const real = (await execCommand("which", ["git"], { cwd: repo })).stdout.trim();
    await writeFile(
      join(shim, "git"),
      `#!/bin/sh\ncase " $* " in *" worktree prune "*) echo boom >&2; exit 3;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim}:${oldPath}`;
    try {
      await expect(pruneStaleWorktrees(repo)).rejects.toThrow(/prune failed.*exit 3.*boom/);
    } finally {
      process.env.PATH = oldPath;
      await rm(shim, { recursive: true, force: true });
    }
  });

  it("repoCommonDir is shared by a checkout, its subdirectory and linked worktrees only", async () => {
    const other = await mkdtemp(join(tmpdir(), "boof-other-"));
    try {
      await execCommand("git", ["init", "-q"], { cwd: other });
      const main = await repoCommonDir(repo);
      expect(main).toBeTruthy();
      expect(await repoCommonDir(other)).not.toBe(main);
      const wt = await addWorktree("common");
      expect(await repoCommonDir(wt.path)).toBe(main);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("registeredWorktreeBranch names the branch of a registered worktree and nothing else", async () => {
    const wt = await addWorktree("reg");
    expect(await registeredWorktreeBranch(repo, wt.path)).toBe(wt.branch);
    expect(await registeredWorktreeBranch(repo, join(repo, "not-a-worktree"))).toBeNull();
    expect(await registeredWorktreeBranch(nonRepo, wt.path)).toBeNull();
  });

  it("leftoversBranch is the task branch plus --leftovers", () => {
    expect(leftoversBranch({ branch: "boof-runner/t1" })).toBe("boof-runner/t1--leftovers");
  });
});

describe("initGitRepo", () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  const gitIn = (dir: string, args: string[]) =>
    execCommand("git", args, { cwd: dir, timeoutMs: 15000, env: { ...process.env, ...env } });
  const count = async (dir: string) =>
    (await gitIn(dir, ["rev-list", "--count", "HEAD"])).stdout.trim();

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "boof-runner-init-"));
    // No user.name/user.email anywhere, and signing forced on: initGitRepo must not depend on them.
    await writeFile(join(base, "gitconfig"), "[commit]\n\tgpgsign = true\n");
    env = {
      HOME: base,
      GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
    };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("makes a repository with one commit, and a worktree can be added", async () => {
    const dir = join(base, "fresh");
    await mkdir(dir, { recursive: true });
    await initGitRepo(dir, { env });
    expect(await isGitRepo(dir)).toBe(true);
    expect(await count(dir)).toBe("1");
    const wtPath = join(base, "wts", "t1");
    await gitIn(dir, ["worktree", "add", "-q", "-b", "t1", wtPath]);
    expect(await exists(wtPath)).toBe(true);
  });

  it("on a repository with commits changes nothing", async () => {
    const dir = join(base, "old");
    await mkdir(dir, { recursive: true });
    await gitIn(dir, ["init", "-q"]);
    await gitIn(dir, [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@b.c",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "x",
    ]);
    const head = (await gitIn(dir, ["rev-parse", "HEAD"])).stdout;
    await initGitRepo(dir, { env });
    expect(await count(dir)).toBe("1");
    expect((await gitIn(dir, ["rev-parse", "HEAD"])).stdout).toBe(head);
  });

  it("on a repository without commits adds the empty commit only", async () => {
    const dir = join(base, "unborn");
    await mkdir(dir, { recursive: true });
    await gitIn(dir, ["init", "-q"]);
    await initGitRepo(dir, { env });
    expect(await count(dir)).toBe("1");
  });

  it("inside a parent repository it makes its own repository and leaves the parent alone", async () => {
    const outer = join(base, "outer");
    await mkdir(outer, { recursive: true });
    await gitIn(outer, ["init", "-q"]);
    await gitIn(outer, [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@b.c",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "outer",
    ]);
    const head = (await gitIn(outer, ["rev-parse", "HEAD"])).stdout;
    const sub = join(outer, "sub");
    await mkdir(sub);
    await initGitRepo(sub, { env });
    expect(await exists(join(sub, ".git"))).toBe(true);
    expect(await count(sub)).toBe("1");
    expect((await gitIn(sub, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("Initial commit");
    expect((await gitIn(outer, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await gitIn(outer, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
  });

  it("uses the configured identity, and Boof Runner only when there is none", async () => {
    const author = async (dir: string) =>
      (await gitIn(dir, ["log", "-1", "--format=%an <%ae>"])).stdout.trim();
    const none = join(base, "none");
    await mkdir(none);
    await initGitRepo(none, { env });
    expect(await author(none)).toBe("Boof Runner <boof-runner@localhost>");

    await writeFile(
      join(base, "gitconfig"),
      "[commit]\n\tgpgsign = true\n[user]\n\tname = Owner\n\temail = owner@example.com\n",
    );
    const owned = join(base, "owned");
    await mkdir(owned);
    await initGitRepo(owned, { env });
    expect(await author(owned)).toBe("Owner <owner@example.com>");
  });

  it("kills a hung git on timeout and fails with a clear error", async () => {
    const bin = join(base, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    await chmod(join(bin, "git"), 0o755);
    const dir = join(base, "hung");
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    await expect(
      initGitRepo(dir, { timeoutMs: 300, env: { ...env, PATH: `${bin}:${process.env.PATH}` } }),
    ).rejects.toThrow(/timed out after 300 ms/);
    // The fake git sleeps 30s. Killing it at 300ms must win; 20s is timer slack under load.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 45_000);
});

describe("agent-planted git config does not run server-side", () => {
  /** An agent sets core.fsmonitor (and a hook) in the shared .git/config; each would drop a file. */
  async function plant(): Promise<{ fsmonitor: string; hook: string }> {
    const fsmonitor = join(nonRepo, "fsmonitor-ran");
    const hook = join(nonRepo, "hook-ran");
    const script = join(nonRepo, "fsmonitor.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${fsmonitor}'\nprintf '/\\0'\n`, { mode: 0o755 });
    await g(["config", "core.fsmonitor", script]);
    const hooks = join(repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${hook}'\n`, {
      mode: 0o755,
    });
    return { fsmonitor, hook };
  }

  it("sanity: plain git status runs the planted fsmonitor", async () => {
    const { fsmonitor } = await plant();
    await g(["status", "--porcelain"]);
    expect(await exists(fsmonitor)).toBe(true);
  });

  it("the shared git helper never runs fsmonitor or hooks", async () => {
    const { fsmonitor, hook } = await plant();
    const st = await git(repo, ["status", "--porcelain"]);
    expect(st.code).toBe(0);
    await git(repo, ["worktree", "add", "-q", "-b", "x", join(repo, ".wts", "x")]);
    expect(await exists(fsmonitor)).toBe(false);
    expect(await exists(hook)).toBe(false);
  });

  it("task diff and the untracked listing never run it", async () => {
    await g(["branch", "boof-runner/t1"]);
    const wt = join(repo, ".wts", "t1");
    await g(["worktree", "add", "-q", wt, "boof-runner/t1"]);
    await writeFile(join(wt, "new.txt"), "x\n");
    const { fsmonitor } = await plant();
    await rm(fsmonitor, { force: true });
    const diff = await taskDiff({ workingDir: repo, taskId: "t1", worktreePath: wt });
    expect(diff.includesUncommitted).toBe(true);
    expect(await untrackedFiles(wt)).toContain("new.txt");
    expect(await exists(fsmonitor)).toBe(false);
  });
  it("never runs a planted diff.external or textconv in task diffs", async () => {
    const ran = join(nonRepo, "extdiff-ran");
    const script = join(nonRepo, "extdiff.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
    await g(["branch", "boof-runner/t2"]);
    const wt = join(repo, ".wts", "t2");
    await g(["worktree", "add", "-q", wt, "boof-runner/t2"]);
    await writeFile(join(wt, "a.txt"), "one\n");
    await g(["config", "diff.external", script]);
    await g(["config", "diff.evil.textconv", script]);
    await writeFile(join(wt, ".gitattributes"), "*.txt diff=evil\n");
    // Sanity: plain git diff runs the external driver.
    await g(["-C", wt, "add", "-N", "a.txt"]);
    await g(["-C", wt, "diff", "HEAD"]);
    expect(await exists(ran)).toBe(true);
    await rm(ran, { force: true });
    const diff = await taskDiff({ workingDir: repo, taskId: "t2", worktreePath: wt });
    expect(diff.includesUncommitted).toBe(true);
    await git(wt, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--stat"]);
    expect(await exists(ran)).toBe(false);
  });
});
