import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHA1_EMPTY_TREE,
  attributesSelectDriver,
  driverOverridesFromConfig,
  git,
  gitVersionSupportsAttrSource,
  hardenedGitCommand,
  initGitRepo,
  isGitRepo,
  leftoversBranch,
  pruneStaleWorktrees,
  registeredWorktreeBranch,
  repoCommonDir,
} from "./git.js";
import { createIntegrationBranch } from "./plan-base.js";
import { execCommand } from "./process.js";
import { taskDiff } from "./task-diff.js";
import { untrackedFiles, untrackedPatch } from "./untracked-diff.js";

let repo: string;
let nonRepo: string;

const g = (args: string[]) =>
  execCommand("git", args, { launch: { kind: "direct" }, cwd: repo, timeoutMs: 15000 });

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
    const real = (
      await execCommand("which", ["git"], { launch: { kind: "direct" }, cwd: repo })
    ).stdout.trim();
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
      await execCommand("git", ["init", "-q"], { launch: { kind: "direct" }, cwd: other });
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
    execCommand("git", args, {
      launch: { kind: "direct" },
      cwd: dir,
      timeoutMs: 15000,
      env: { ...process.env, ...env },
    });
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

describe("git capability and info/attributes parsing", () => {
  it("treats git 2.40 as the first version with --attr-source", () => {
    expect(gitVersionSupportsAttrSource("git version 2.39.5 (Apple Git-154)")).toBe(false);
    expect(gitVersionSupportsAttrSource("git version 2.39.0.windows.1")).toBe(false);
    expect(gitVersionSupportsAttrSource("git version 2.40.0")).toBe(true);
    expect(gitVersionSupportsAttrSource("git version 2.40")).toBe(true);
    expect(gitVersionSupportsAttrSource("git version 2.40.0.windows.1")).toBe(true);
    expect(gitVersionSupportsAttrSource("git version 2.43.0")).toBe(true);
    expect(gitVersionSupportsAttrSource("git version 3.0.0")).toBe(true);
    expect(gitVersionSupportsAttrSource("git version 1.9.1")).toBe(false);
    expect(gitVersionSupportsAttrSource("not git")).toBe(false);
  });

  it("selects only filter= and merge= attributes", () => {
    expect(attributesSelectDriver("* filter=late\n")).toBe(true);
    expect(attributesSelectDriver("* merge=late\n")).toBe(true);
    expect(attributesSelectDriver("* filter=x=y\n* merge=ours\n")).toBe(true);
    expect(attributesSelectDriver("[attr]bin filter=late\n* bin\n")).toBe(true);
    expect(attributesSelectDriver('"spa ce" filter=late\n')).toBe(true);
    expect(attributesSelectDriver("* text\n*.png binary\n")).toBe(false);
    expect(attributesSelectDriver("# * filter=late\n")).toBe(false);
    expect(attributesSelectDriver("*filter=late text\n")).toBe(false);
    expect(attributesSelectDriver("* -filter\n* !merge\n* filter\n")).toBe(false);
    expect(attributesSelectDriver('"* filter=late"\n')).toBe(false);
    expect(attributesSelectDriver("* diff=evil\n")).toBe(false);
    expect(attributesSelectDriver("")).toBe(false);
    expect(attributesSelectDriver("* filter=late\r\n")).toBe(true);
  });
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

  it("blanks every filter key and merge driver, including names that contain '='", () => {
    const listed = [
      "filter.lfs.clean\ngit-lfs clean -- %f\0",
      "filter.evil.clean\n/tmp/filt.sh\0",
      "filter.evil.smudge\n/tmp/filt.sh\0",
      "filter.evil.required\ntrue\0",
      "filter.bad name.clean\ntouch /tmp/x\0",
      "filter.x=y.clean\n/tmp/filt.sh\0",
      "filter.x=y.required\ntrue\0",
      "merge.ours.name\nbuilt-in label\0",
      "merge.x=y.driver\n/tmp/merge.sh %O %A %B\0",
    ].join("");
    expect(driverOverridesFromConfig(listed)).toEqual([
      { key: "filter.bad name.clean", value: "" },
      { key: "filter.evil.clean", value: "" },
      { key: "filter.evil.required", value: "false" },
      { key: "filter.evil.smudge", value: "" },
      { key: "filter.lfs.clean", value: "" },
      { key: "filter.x=y.clean", value: "" },
      { key: "filter.x=y.required", value: "false" },
      { key: "merge.x=y.driver", value: "" },
    ]);
  });

  it("server git does not run a planted clean or smudge filter", async () => {
    const ran = join(nonRepo, "filter-ran");
    const script = join(nonRepo, "filter.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`, { mode: 0o755 });
    await g(["config", "filter.evil.clean", script]);
    await g(["config", "filter.evil.smudge", script]);
    await g(["config", "filter.evil.required", "true"]);
    await writeFile(join(repo, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(repo, "a.txt"), "one\n");
    await g(["add", "a.txt"]);
    expect(await exists(ran)).toBe(true);
    await rm(ran, { force: true });

    await writeFile(join(repo, "a.txt"), "two\n");
    const diff = await git(repo, ["diff", "--", "a.txt"]);
    expect(diff.code).not.toBeNull();
    expect(diff.out).toContain("two");
    const added = await git(repo, ["add", "--", "a.txt"]);
    expect(added.code).toBe(0);
    expect(await exists(ran)).toBe(false);

    await g(["branch", "boof-runner/t3"]);
    const wt = join(repo, ".wts", "t3");
    await g(["worktree", "add", "-q", wt, "boof-runner/t3"]);
    await writeFile(join(wt, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(wt, "a.txt"), "three\n");
    await rm(ran, { force: true });
    const task = await taskDiff({ workingDir: repo, taskId: "t3", worktreePath: wt });
    expect(task.includesUncommitted).toBe(true);
    await writeFile(join(wt, "new.txt"), "x\n");
    expect(await untrackedFiles(wt)).toContain("new.txt");
    expect(await untrackedPatch(wt, "new.txt")).toContain("x");
    expect(await exists(ran)).toBe(false);
  });

  it("server git does not run a planted filter whose name contains '='", async () => {
    const ran = join(nonRepo, "equals-filter-ran");
    const script = join(nonRepo, "equals-filter.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`, { mode: 0o755 });
    await g(["config", "filter.x=y.clean", script]);
    await g(["config", "filter.x=y.smudge", script]);
    await g(["config", "filter.x=y.required", "true"]);
    await writeFile(join(repo, ".gitattributes"), "* filter=x=y\n");
    await writeFile(join(repo, "a.txt"), "one\n");
    await g(["add", "a.txt"]);
    expect(await exists(ran)).toBe(true);
    await rm(ran, { force: true });

    await writeFile(join(repo, "a.txt"), "two\n");
    const diff = await git(repo, ["diff", "--", "a.txt"]);
    expect(diff.code).not.toBeNull();
    expect(diff.out).toContain("two");
    const added = await git(repo, ["add", "--", "a.txt"]);
    expect(added.code).toBe(0);
    expect(await exists(ran)).toBe(false);
  });

  it("an integration merge does not run a planted merge driver whose name contains '='", async () => {
    const ran = join(nonRepo, "merge-ran");
    const script = join(nonRepo, "merge.sh");
    await writeFile(script, `#!/bin/sh\necho MERGE >> '${ran}'\nexit 0\n`, { mode: 0o755 });
    await writeFile(join(repo, ".gitattributes"), "* merge=x=y\n");
    await g(["add", ".gitattributes"]);
    await g(["commit", "-q", "-m", "attr"]);
    await g(["checkout", "-q", "-b", "left"]);
    await writeFile(join(repo, "m.txt"), "left\n");
    await g(["add", "m.txt"]);
    await g(["commit", "-q", "-m", "left"]);
    await g(["checkout", "-q", "main"]);
    await g(["checkout", "-q", "-b", "right"]);
    await writeFile(join(repo, "m.txt"), "right\n");
    await g(["add", "m.txt"]);
    await g(["commit", "-q", "-m", "right"]);
    await g(["config", "merge.x=y.driver", script]);
    const left = (await g(["rev-parse", "left"])).stdout.trim();
    await g(["checkout", "-q", "left"]);
    await g(["merge", "--no-ff", "--no-edit", "-m", "plain", "right"]);
    expect(await exists(ran)).toBe(true);
    await g(["reset", "--hard", left]);
    await rm(ran, { force: true });

    const integrated = await createIntegrationBranch(repo, "int-base", ["left", "right"]);
    expect(integrated.ok).toBe(false);
    expect(await exists(ran)).toBe(false);
  });

  it("refuses a filter planted in .git/info/attributes and does not run it", async () => {
    const wt = await addWorktree("info-attr");
    const ran = join(nonRepo, "info-filter-ran");
    const script = join(nonRepo, "info-filter.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`, { mode: 0o755 });
    await g(["config", "filter.late.clean", script]);
    await mkdir(join(repo, ".git", "info"), { recursive: true });
    await writeFile(join(repo, ".git", "info", "attributes"), "* filter=late\n");
    await writeFile(join(repo, "a.txt"), "content\n");
    await writeFile(join(wt.path, "b.txt"), "content\n");
    await expect(git(repo, ["add", "--", "a.txt"])).rejects.toThrow(
      /info\/attributes sets a filter= or merge= attribute/,
    );
    await expect(git(wt.path, ["add", "--", "b.txt"])).rejects.toThrow(/info\/attributes/);
    expect(await exists(ran)).toBe(false);
    const merged = await createIntegrationBranch(repo, "int-info", ["main", "missing"]);
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toMatch(/info\/attributes sets a filter= or merge= attribute/);
    expect(await exists(ran)).toBe(false);

    await writeFile(join(repo, ".git", "info", "attributes"), "* merge=late\n");
    await expect(git(repo, ["status", "--porcelain"])).rejects.toThrow(
      /info\/attributes sets a filter= or merge= attribute/,
    );
    expect(await exists(ran)).toBe(false);
  });

  it("allows info/attributes that do not assign a filter or merge driver", async () => {
    await mkdir(join(repo, ".git", "info"), { recursive: true });
    await writeFile(
      join(repo, ".git", "info", "attributes"),
      "# comment filter=late\n*filter=late text\n* text\n*.png binary\n",
    );
    const st = await git(repo, ["status", "--porcelain"]);
    expect(st.code).toBe(0);
  });

  it("omits --attr-source before git 2.40 and still blanks filters and info/attributes", async () => {
    const apple = { versionText: "git version 2.39.5 (Apple Git-154)" };
    const prepared = await hardenedGitCommand(
      repo,
      ["status", "--porcelain"],
      undefined,
      15_000,
      apple,
    );
    expect(prepared.args.some((arg) => arg.startsWith("--attr-source="))).toBe(false);
    expect(prepared.args).toContain("core.fsmonitor=false");
    expect(prepared.args).toContain("core.hooksPath=/dev/null");
    expect(prepared.args).toContain("core.attributesFile=/dev/null");

    const ran = join(nonRepo, "old-git-filter-ran");
    const script = join(nonRepo, "old-git-filter.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`, { mode: 0o755 });
    await g(["config", "filter.evil.clean", script]);
    await g(["config", "filter.evil.required", "true"]);
    await writeFile(join(repo, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(repo, "a.txt"), "one\n");
    const added = await git(repo, ["add", "--", "a.txt"], undefined, 15_000, apple);
    expect(added.code).toBe(0);
    expect(await exists(ran)).toBe(false);

    await mkdir(join(repo, ".git", "info"), { recursive: true });
    await writeFile(join(repo, ".git", "info", "attributes"), "* filter=late\n");
    await g(["config", "filter.late.clean", script]);
    await rm(ran, { force: true });
    await expect(git(repo, ["add", "--", "a.txt"], undefined, 15_000, apple)).rejects.toThrow(
      /info\/attributes sets a filter= or merge= attribute/,
    );
    expect(await exists(ran)).toBe(false);
  });

  it("passes the SHA-1 empty tree on git 2.40 without hashing, and hashes when the format is sha256", async () => {
    const lines = async (logPath: string) =>
      (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const withLog = async (fn: (logPath: string) => Promise<void>) => {
      const shim = await mkdtemp(join(tmpdir(), "boof-gitlog-"));
      const logPath = join(shim, "log");
      const real = (
        await execCommand("which", ["git"], { launch: { kind: "direct" }, cwd: repo })
      ).stdout.trim();
      await writeFile(
        join(shim, "git"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      );
      const oldPath = process.env.PATH;
      process.env.PATH = `${shim}:${oldPath ?? ""}`;
      try {
        await fn(logPath);
      } finally {
        process.env.PATH = oldPath;
        await rm(shim, { recursive: true, force: true });
      }
    };

    const sawHashObject = async (logPath: string) =>
      (await lines(logPath)).some((line) => line.includes("hash-object"));

    await withLog(async (logPath) => {
      const prepared = await hardenedGitCommand(repo, ["status"], undefined, 15_000, {
        versionText: "git version 2.40.0",
        objectFormat: "sha1",
      });
      expect(prepared.args[0]).toBe(`--attr-source=${SHA1_EMPTY_TREE}`);
      expect(await sawHashObject(logPath)).toBe(false);
    });

    await withLog(async (logPath) => {
      const prepared = await hardenedGitCommand(repo, ["status"], undefined, 15_000, {
        versionText: "git version 2.43.0",
        objectFormat: "sha256",
      });
      // This fixture is SHA-1, so hash-object's empty tree is the SHA-1 id. The call is the point:
      // a sha256 format must not skip the hash and assume the constant.
      expect(prepared.args[0]).toBe(`--attr-source=${SHA1_EMPTY_TREE}`);
      expect(await sawHashObject(logPath)).toBe(true);
    });
  });

  it("uses the repository's own empty tree in a SHA-256 repo", async () => {
    const shaRepo = await mkdtemp(join(tmpdir(), "boof-sha256-"));
    try {
      const init = await execCommand("git", ["init", "--object-format=sha256", "-q"], {
        launch: { kind: "direct" },
        cwd: shaRepo,
        timeoutMs: 15_000,
      });
      expect(init.code).toBe(0);
      const hashed = await execCommand(
        "git",
        ["hash-object", "-t", "tree", "--no-filters", "--stdin"],
        { launch: { kind: "direct" }, cwd: shaRepo, timeoutMs: 15_000, input: "" },
      );
      const oid = hashed.stdout.trim();
      expect(oid).not.toBe(SHA1_EMPTY_TREE);
      const prepared = await hardenedGitCommand(shaRepo, ["status", "--porcelain"]);
      expect(prepared.args[0]).toBe(`--attr-source=${oid}`);
      await writeFile(join(shaRepo, "a.txt"), "one\n");
      const added = await git(shaRepo, ["add", "--", "a.txt"]);
      expect(added.code).toBe(0);
      expect(added.err).not.toMatch(/bad --attr-source/);
    } finally {
      await rm(shaRepo, { recursive: true, force: true });
    }
  });

  it("does not select a filter added after the driver list was read", async () => {
    const ran = join(nonRepo, "late-filter-ran");
    const script = join(nonRepo, "late-filter.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`, { mode: 0o755 });
    await writeFile(join(repo, ".gitattributes"), "* filter=late\n");
    await writeFile(join(repo, "late.txt"), "content\n");
    await withListingShim(
      `    __REAL_GIT__ "$@"\n    __REAL_GIT__ config filter.late.clean '${script}'\n    __REAL_GIT__ config filter.late.smudge '${script}'`,
      async () => {
        const added = await git(repo, ["add", "--", "late.txt"]);
        expect(added.code).toBe(0);
      },
    );
    expect(await exists(ran)).toBe(false);
  });

  /** `git` on PATH fails or hangs the driver listing and records any later git command. */
  async function withListingShim(body: string, fn: (ran: string) => Promise<void>): Promise<void> {
    const shim = await mkdtemp(join(tmpdir(), "boof-gitshim-"));
    const ran = join(shim, "ran");
    const real = (
      await execCommand("which", ["git"], { launch: { kind: "direct" }, cwd: repo })
    ).stdout.trim();
    await writeFile(
      join(shim, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" --get-regexp "*)\n${body.replaceAll("__REAL_GIT__", real)}\n    ;;\n  *" --version "*|*" --git-common-dir "*|*" --show-object-format "*|*" hash-object "*)\n    exec '${real}' "$@"\n    ;;\nesac\ntouch '${ran}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim}:${oldPath ?? ""}`;
    try {
      await fn(ran);
    } finally {
      process.env.PATH = oldPath;
      await rm(shim, { recursive: true, force: true });
    }
  }

  it("refuses the git command when the driver list cannot be read", async () => {
    await withListingShim("    echo 'config unreadable' >&2\n    exit 3", async (ran) => {
      await expect(git(repo, ["status", "--porcelain"])).rejects.toThrow(
        /could not list filter and merge drivers \(config unreadable\)/,
      );
      expect(await exists(ran)).toBe(false);
      const merged = await createIntegrationBranch(repo, "int-base", ["main", "missing"]);
      expect(merged.ok).toBe(false);
      if (merged.ok) return;
      expect(merged.reason).toMatch(
        /could not list filter and merge drivers \(config unreadable\)/,
      );
      expect(await exists(ran)).toBe(false);
    });
  });

  it("refuses the git command when the driver list times out", async () => {
    await withListingShim("    exec sleep 30", async (ran) => {
      const started = Date.now();
      await expect(git(repo, ["status", "--porcelain"], undefined, 400)).rejects.toThrow(
        /could not list filter and merge drivers \(timed out after 400 ms\)/,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await exists(ran)).toBe(false);
    });
  });
});
