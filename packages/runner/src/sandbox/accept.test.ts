import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  execCommand,
  leftoversBranch,
  repoCommonDir,
  resetSandboxStatus,
  sandboxSettingsFingerprint,
  setSandboxStatus,
} from "@boof/heart";
import { commitLeftovers, createWorktree, finalizeWorktree, type Worktree } from "../worktree.js";
import { importPrivateGitObjects, prepareAgentLaunch, type SandboxSettingsView } from "./index.js";
import type { AgentLaunchContext } from "./runtime.js";
import { createRunTemp } from "./runtime.js";

const linux = process.platform === "linux";
const darwin = process.platform === "darwin";
const required = process.env.BOOF_REQUIRE_SANDBOX === "1";
const here = dirname(fileURLToPath(import.meta.url));
const sandboxDir = join(here, "../../../sandbox-linux");
const helper = join(sandboxDir, "dist/boof-sandbox");
const probe = join(sandboxDir, "dist/probe");

const sandboxSettings: SandboxSettingsView = {
  mode: "enforce",
  readPaths: [],
  writePaths: [],
  denyTcpPorts: [],
};

interface Fixture {
  base: string;
  env: NodeJS.ProcessEnv;
  repo: string;
  secret: string;
  wt: Worktree;
  temp: string;
  ctx: AgentLaunchContext;
}

const roots: string[] = [];

function shQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(!linux && !darwin && !required)("sandbox acceptance A9-A12", () => {
  if (!linux && !darwin) {
    it("fails closed when the sandbox is required", () => {
      throw new Error("BOOF_REQUIRE_SANDBOX=1 but this platform has no sandbox backend");
    });
    return;
  }

  beforeAll(() => {
    if (!linux) return;
    const source = join(sandboxDir, "boof-sandbox.c");
    const stale = !existsSync(helper) || statSync(helper).mtimeMs < statSync(source).mtimeMs;
    if (!stale) return;
    const built = spawnSync(process.execPath, [join(sandboxDir, "build.mjs")], {
      encoding: "utf8",
    });
    if (built.status !== 0) {
      throw new Error(built.stderr || built.stdout || "build.mjs failed");
    }
    if (!existsSync(helper)) throw new Error("build.mjs produced no helper on Linux");
    const compiledProbe = spawnSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-o", probe, join(sandboxDir, "probe.c")], { encoding: "utf8" });
    if (compiledProbe.status !== 0) throw new Error(compiledProbe.stderr || "could not build sandbox probe");
  }, 60_000);

  afterEach(async () => {
    resetSandboxStatus();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    const res = await execCommand("git", args, {
      launch: { kind: "direct" },
      cwd,
      env,
      timeoutMs: 15_000,
    });
    if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  }

  async function fixture(): Promise<Fixture> {
    const base = await mkdtemp(join(tmpdir(), "boof-i1e-a-"));
    roots.push(base);
    const home = join(base, "home");
    const data = join(base, "data");
    const repo = join(base, "repo");
    const wtRoot = join(base, "wt");
    await mkdir(join(home, ".local", "state"), { recursive: true });
    await mkdir(data);
    await mkdir(repo);
    await mkdir(wtRoot);
    const secret = join(data, "secret");
    await writeFile(secret, "top-secret\n");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    delete env.GIT_CONFIG_COUNT;
    delete env.BOOF_SANDBOX_HELPER;
    await git(repo, ["init", "-b", "main"], env);
    await git(repo, ["config", "user.name", "Ada Lovelace"], env);
    await git(repo, ["config", "user.email", "ada@example.com"], env);
    await git(repo, ["config", "commit.gpgsign", "false"], env);
    await writeFile(join(repo, "README"), "hi\n");
    await git(repo, ["add", "README"], env);
    await git(repo, ["commit", "-m", "init"], env);
    const wt = (await createWorktree(repo, "task-1", { root: wtRoot })).worktree;
    const temp = await createRunTemp({ dataRoot: data, projectId: "proj", env });
    const ctx: AgentLaunchContext = {
      dataRoot: data,
      projectId: "proj",
      tool: "mock",
      writableRoot: wt.path,
      mainCheckout: repo,
      runTempDir: temp,
      env,
      helper,
    };
    return { base, env, repo, secret, wt, temp, ctx };
  }

  async function sandboxed(fx: Fixture, script: string) {
    setSandboxStatus(
      {
        mode: "enforce",
        backend: darwin ? "darwin" : "linux",
        state: "ok",
        reason: "",
      },
      sandboxSettingsFingerprint(sandboxSettings),
    );
    const launch = await prepareAgentLaunch({ runner: { sandbox: sandboxSettings } }, fx.ctx);
    if (launch.kind !== "sandbox") throw new Error("expected a sandbox launch");
    const result = await execCommand("/bin/sh", ["-c", script], {
      cwd: fx.wt.path,
      launch,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      timeoutMs: 20_000,
    });
    return { launch, result };
  }

  it("A9 writes in the worktree, TMPDIR, agent home and cache", async () => {
    const fx = await fixture();
    const { launch, result } = await sandboxed(
      fx,
      [
        "set -e",
        "printf 'work\\n' > a9-work.txt",
        "printf 'temp\\n' > \"$TMPDIR/a9-temp.txt\"",
        "printf 'home\\n' > \"$HOME/a9-home.txt\"",
        "printf 'cache\\n' > \"$XDG_CACHE_HOME/a9-cache.txt\"",
        "echo A9_OK",
      ].join("\n"),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("A9_OK");
    expect(await readFile(join(fx.wt.path, "a9-work.txt"), "utf8")).toBe("work\n");
    expect(await readFile(join(fx.temp, "a9-temp.txt"), "utf8")).toBe("temp\n");
    expect(await readFile(join(launch.policy.env.HOME, "a9-home.txt"), "utf8")).toBe("home\n");
    expect(await readFile(join(launch.policy.env.XDG_CACHE_HOME, "a9-cache.txt"), "utf8")).toBe(
      "cache\n",
    );
    expect(launch.policy.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(launch.policy.env.TMPDIR).toBe(fx.temp);
  }, 45_000);

  // Design section 7: macOS rows are A1–A9 and A12–A17. Git common-dir rows stay on Linux.
  it.skipIf(darwin)(
    "A10 adds, commits, and reads status, diff and log",
    async () => {
      const fx = await fixture();
      const { launch, result } = await sandboxed(
        fx,
        [
          "set -e",
          "printf 'hello\\n' > sandbox-tracked.txt",
          "git add -- sandbox-tracked.txt",
          "git -c commit.gpgsign=false commit -m 'sandbox commit'",
          'git status --porcelain > "$TMPDIR/status.txt"',
          'git log -1 --format=%an > "$TMPDIR/author.txt"',
          'if git diff --exit-code HEAD~1 -- sandbox-tracked.txt > "$TMPDIR/diff.txt"; then',
          "  echo DIFF_CLEAN",
          "  exit 1",
          "fi",
          'test ! -s "$TMPDIR/status.txt"',
          'test -s "$TMPDIR/diff.txt"',
          "echo A10_OK",
        ].join("\n"),
      );
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("A10_OK");
      await importPrivateGitObjects({
        runTempDir: fx.temp,
        writableRoot: fx.wt.path,
        mainCheckout: fx.repo,
      });
      expect(launch.policy.env.GIT_AUTHOR_NAME).toBe("Ada Lovelace");
      expect(launch.policy.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      const author = await git(fx.wt.path, ["log", "-1", "--format=%an%n%ae"], fx.env);
      expect(author).toBe("Ada Lovelace\nada@example.com");
      const status = await git(fx.wt.path, ["status", "--porcelain"], fx.env);
      expect(status).toBe("");
      const diff = await git(fx.wt.path, ["diff", "HEAD~1", "--", "sandbox-tracked.txt"], fx.env);
      expect(diff).toContain("hello");
    },
    45_000,
  );

  it.skipIf(darwin)(
    "A11 denies writes to config, hooks, info and refs/heads/main",
    async () => {
      const fx = await fixture();
      const common = await repoCommonDir(fx.wt.path);
      expect(common).toBeTruthy();
      const configPath = join(common!, "config");
      const mainRef = join(common!, "refs", "heads", "main");
      expect(existsSync(join(common!, "hooks"))).toBe(true);
      expect(existsSync(join(common!, "info"))).toBe(true);
      const configBefore = await readFile(configPath, "utf8");
      const mainBefore = await readFile(mainRef, "utf8");
      const quoted = shQuote(common!);
      const { result } = await sandboxed(
        fx,
        [
          `common=${quoted}`,
          'try_write() { if printf x > "$1" 2>"$TMPDIR/err"; then echo "WROTE $2"; else echo "DENIED $2"; cat "$TMPDIR/err"; fi; }',
          'try_write "$common/config" config',
          'try_write "$common/hooks/pre-commit" hooks',
          'try_write "$common/info/attributes" attributes',
          'if git update-ref refs/heads/main HEAD 2>"$TMPDIR/err"; then echo "WROTE refs/heads/main"; else echo "DENIED refs/heads/main"; cat "$TMPDIR/err"; fi',
          "echo A11_OK",
        ].join("\n"),
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("A11_OK");
      expect(result.stdout).toContain("DENIED config");
      expect(result.stdout).toContain("DENIED hooks");
      expect(result.stdout).toContain("DENIED attributes");
      expect(result.stdout).toContain("DENIED refs/heads/main");
      expect(result.stdout).not.toContain("WROTE");
      expect(result.stdout).toContain("Permission denied");
      expect(await readFile(configPath, "utf8")).toBe(configBefore);
      expect(await readFile(mainRef, "utf8")).toBe(mainBefore);
      expect(existsSync(join(common!, "hooks", "pre-commit"))).toBe(false);
      expect(existsSync(join(common!, "info", "attributes"))).toBe(false);
    },
    45_000,
  );

  it("A12 denies a worktree symlink into the data root", async () => {
    const fx = await fixture();
    await symlink(fx.secret, join(fx.wt.path, "leak"));
    const { result } = await sandboxed(
      fx,
      [
        "cat_code=0",
        'content=$(cat leak 2>"$TMPDIR/cat.err") || cat_code=$?',
        'echo "cat_code=$cat_code"',
        "printf '%s\\n' \"$content\"",
        'cat "$TMPDIR/cat.err"',
        "write_code=0",
        'printf pwn > leak 2>"$TMPDIR/write.err" || write_code=$?',
        'echo "write_code=$write_code"',
        'cat "$TMPDIR/write.err"',
        "echo A12_OK",
      ].join("\n"),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("A12_OK");
    // Landlock says "Permission denied". Seatbelt says "Operation not permitted".
    expect(result.stdout).toMatch(/Permission denied|Operation not permitted/);
    expect(result.stdout).not.toContain("top-secret");
    const cat = /cat_code=(\d+)/.exec(result.stdout);
    const write = /write_code=(\d+)/.exec(result.stdout);
    expect(cat?.[1]).not.toBe("0");
    expect(write?.[1]).not.toBe("0");
    expect(await readFile(fx.secret, "utf8")).toBe("top-secret\n");
  }, 45_000);

  it("commits leftovers the sandboxed agent left, and keep leaves the directory", async () => {
    const fx = await fixture();
    const { result } = await sandboxed(fx, "printf 'left\\n' > left.txt\necho LEFT_OK");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("LEFT_OK");
    const left = await commitLeftovers(fx.repo, fx.wt, "task-1");
    expect(left).not.toBeNull();
    expect(left!.unsaved).toEqual([]);
    expect(left!.branch).toBe(leftoversBranch(fx.wt));
    const tree = await git(fx.wt.path, ["ls-tree", "-r", "--name-only", left!.sha], fx.env);
    expect(tree.split("\n")).toContain("left.txt");
    const lines = await finalizeWorktree(fx.repo, fx.wt, "task-1", "keep");
    expect(lines.some((line) => line.startsWith("Leftovers committed"))).toBe(true);
    expect(existsSync(fx.wt.path)).toBe(true);
  }, 45_000);

  it("denies the sandboxed agent writes and symlink creation under common reflogs", async () => {
    const fx = await fixture();
    const common = (await repoCommonDir(fx.repo))!;
    const logPath = join(common, "logs", "agent-planted");
    const target = join(fx.wt.path, "reflog-target");
    await writeFile(target, "safe\n");
    const { launch, result } = await sandboxed(
      fx,
      [
        `if ln -s ${shQuote(target)} ${shQuote(logPath)}; then echo LINKED; else echo LINK_DENIED; fi`,
        `if printf pwn > ${shQuote(logPath)}; then echo WRITTEN; else echo WRITE_DENIED; fi`,
      ].join("\n"),
    );
    expect(launch.policy.readWrite).not.toContain(join(common, "logs"));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("LINK_DENIED");
    expect(result.stdout).toContain("WRITE_DENIED");
    expect(await readFile(target, "utf8")).toBe("safe\n");
  }, 45_000);

  it.skipIf(!linux)("denies the default server port even when no server is running", async () => {
    const fx = await fixture();
    const localProbe = join(fx.wt.path, "probe");
    await copyFile(probe, localProbe);
    await chmod(localProbe, 0o755);
    setSandboxStatus(
      { mode: "enforce", backend: "linux", state: "ok", reason: "" },
      sandboxSettingsFingerprint(sandboxSettings),
    );
    const launch = await prepareAgentLaunch({ runner: { sandbox: sandboxSettings } }, fx.ctx);
    if (launch.kind !== "sandbox") throw new Error("expected a sandbox launch");
    expect(launch.policy.denyTcpPorts).toContain(4319);
    const result = await execCommand(localProbe, ["bind4", "4319"], {
      cwd: fx.wt.path,
      launch,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      timeoutMs: 20_000,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("bind EACCES\n");
  }, 45_000);
});
