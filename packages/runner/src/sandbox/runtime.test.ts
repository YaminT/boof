import { closeSync, constants, existsSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand, repoCommonDir } from "@boof/heart";
import { createWorktree } from "../worktree.js";
import {
  NON_INTERACTIVE,
  SANDBOX_DEVELOPER_LIMITS,
  SYSTEM_PROMPTS,
  withSandboxLimits,
} from "../pipeline.js";
import {
  buildRunPolicy,
  createRunTemp,
  readGitIdentity,
  reapCrashedRunTemps,
  removeRunTemp,
  type AgentLaunchContext,
} from "./runtime.js";

const linux = process.platform === "linux";
const required = process.env.BOOF_REQUIRE_SANDBOX === "1";

const sandboxSettings = {
  mode: "enforce" as const,
  readPaths: [] as string[],
  writePaths: [] as string[],
  denyTcpPorts: [] as number[],
};

interface Fixture {
  base: string;
  home: string;
  env: NodeJS.ProcessEnv;
  data: string;
  repo: string;
  wtPath: string;
  temp: string;
  ctx: AgentLaunchContext;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function opens(path: string): boolean {
  const flag = constants.O_PATH;
  if (typeof flag !== "number") return existsSync(path);
  try {
    const fd = openSync(path, flag | constants.O_CLOEXEC);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const res = await execCommand("git", args, {
    launch: { kind: "direct" },
    cwd,
    env,
    timeoutMs: 15_000,
  });
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

/** Scratch home with the state folder inside it, matching `~/.local/state`. */
async function fixture(linked: boolean): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "boof-i1e-rt-"));
  roots.push(base);
  const home = join(base, "home");
  const data = join(base, "data");
  const repo = join(base, "repo");
  const wtRoot = join(base, "wt");
  await mkdir(join(home, ".local", "state"), { recursive: true });
  await mkdir(data);
  await mkdir(repo);
  await mkdir(wtRoot);
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
  await git(repo, ["init", "-b", "main"], env);
  await git(repo, ["config", "user.name", "Ada Lovelace"], env);
  await git(repo, ["config", "user.email", "ada@example.com"], env);
  await git(repo, ["config", "commit.gpgsign", "false"], env);
  await writeFile(join(repo, "README"), "hi\n");
  await git(repo, ["add", "README"], env);
  await git(repo, ["commit", "-m", "init"], env);
  const wtPath = linked
    ? (await createWorktree(repo, "task-1", { root: wtRoot })).worktree.path
    : repo;
  const temp = await createRunTemp({ dataRoot: data, projectId: "proj", env });
  const ctx: AgentLaunchContext = {
    dataRoot: data,
    projectId: "proj",
    tool: "mock",
    writableRoot: wtPath,
    mainCheckout: repo,
    runTempDir: temp,
    env,
    helper: "/never-spawned",
  };
  return { base, home, env, data, repo, wtPath, temp, ctx };
}

describe("developer sandbox sentence", () => {
  it("names the git commands that fail and keeps temporary files in $TMPDIR", () => {
    const developer = withSandboxLimits(SYSTEM_PROMPTS.developer, "enforce");
    const fix = withSandboxLimits(SYSTEM_PROMPTS.developerFix, "enforce");
    expect(developer).toContain(SANDBOX_DEVELOPER_LIMITS);
    expect(fix).toContain(SANDBOX_DEVELOPER_LIMITS);
    expect(withSandboxLimits(developer, "enforce")).toBe(developer);
    expect(withSandboxLimits(SYSTEM_PROMPTS.developer, "off")).toBe(SYSTEM_PROMPTS.developer);
    expect(SYSTEM_PROMPTS.developer).not.toContain("git stash");
    expect(SYSTEM_PROMPTS.planner).not.toContain(SANDBOX_DEVELOPER_LIMITS);
    expect(SYSTEM_PROMPTS.observer).not.toContain(SANDBOX_DEVELOPER_LIMITS);
    expect(SYSTEM_PROMPTS.reviewer).not.toContain(SANDBOX_DEVELOPER_LIMITS);
    expect(NON_INTERACTIVE).not.toContain("/tmp/x.done");
    expect(NON_INTERACTIVE).not.toContain("/tmp/x.log");
    expect(NON_INTERACTIVE).toContain("mktemp -d");
  });
});

describe.skipIf(!linux && !required)("run temp and git policy facts", () => {
  if (!linux) {
    it("fails closed when the Linux sandbox is required", () => {
      throw new Error("BOOF_REQUIRE_SANDBOX=1 but the Linux sandbox backend is absent");
    });
    return;
  }

  it("creates a mode 700 run directory and refuses to delete anything else", async () => {
    const fx = await fixture(false);
    const info = await stat(fx.temp);
    expect(info.mode & 0o777).toBe(0o700);
    expect((await stat(dirname(fx.temp))).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(dirname(fx.temp)))).mode & 0o777).toBe(0o700);
    await writeFile(join(fx.temp, "marker"), "x");
    await removeRunTemp(fx.temp);
    expect(existsSync(fx.temp)).toBe(false);

    const stray = await mkdtemp(join(tmpdir(), "boof-i1e-stray-"));
    roots.push(stray);
    await writeFile(join(stray, "keep"), "x");
    await removeRunTemp(stray);
    await removeRunTemp("/tmp");
    expect(existsSync(join(stray, "keep"))).toBe(true);
    expect(existsSync("/tmp")).toBe(true);
  });

  it("drops a crashed run at the next sweep and leaves home, cache and other roots", async () => {
    const fx = await fixture(false);
    const project = dirname(dirname(fx.temp));
    const home = join(project, "home");
    const cache = join(project, "cache");
    await mkdir(home);
    await mkdir(cache);
    await writeFile(join(home, "keep.txt"), "home\n");
    await writeFile(join(cache, "keep.txt"), "cache\n");
    await writeFile(join(fx.temp, "marker"), "gone\n");

    const otherData = join(fx.base, "other-data");
    await mkdir(otherData);
    const otherTemp = await createRunTemp({ dataRoot: otherData, projectId: "proj", env: fx.env });
    await writeFile(join(otherTemp, "keep.txt"), "other\n");

    const agents = join(fx.home, ".local", "state", "boof-runner", "agents");
    const odd = join(agents, "ab".repeat(32), "Not_A_Project", "runs");
    await mkdir(odd, { recursive: true });
    await writeFile(join(odd, "keep.txt"), "odd\n");

    await reapCrashedRunTemps(fx.data, fx.env);
    expect(existsSync(fx.temp)).toBe(false);
    expect(existsSync(dirname(fx.temp))).toBe(false);
    expect(await readFile(join(home, "keep.txt"), "utf8")).toBe("home\n");
    expect(await readFile(join(cache, "keep.txt"), "utf8")).toBe("cache\n");
    expect(await readFile(join(otherTemp, "keep.txt"), "utf8")).toBe("other\n");
    expect(await readFile(join(odd, "keep.txt"), "utf8")).toBe("odd\n");
  });

  it("does not create the state directory when there is nothing to reap", async () => {
    const base = await mkdtemp(join(tmpdir(), "boof-i1e-empty-"));
    roots.push(base);
    const data = join(base, "data");
    const state = join(base, "missing-state");
    await mkdir(data);
    await reapCrashedRunTemps(data, { XDG_STATE_HOME: state, HOME: join(base, "home") });
    expect(existsSync(state)).toBe(false);
  });

  it("reads git var from the main checkout and falls back when ident is unusable", async () => {
    const fx = await fixture(false);
    const ident = await readGitIdentity(fx.repo, fx.env);
    expect(ident).toEqual({
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
      committerName: "Ada Lovelace",
      committerEmail: "ada@example.com",
    });
    expect(await readGitIdentity(fx.data, fx.env)).toBeUndefined();

    const bin = join(fx.base, "fake-bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        "cmd=",
        'for arg in "$@"; do',
        '  case "$arg" in',
        "    rev-parse|config|var|hash-object|--version) cmd=$arg ;;",
        "  esac",
        "done",
        'case "$cmd" in',
        "  rev-parse) echo true; exit 0 ;;",
        '  --version) echo "git version 2.43.0"; exit 0 ;;',
        "  hash-object) echo 4b825dc642cb6eb9a060e54bf8d69288fbee4904; exit 0 ;;",
        "  config) exit 1 ;;",
        '  var) echo "fatal: no ident" >&2; exit 128 ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "git"), 0o755);
    const fallback = await readGitIdentity(fx.repo, {
      PATH: bin,
      HOME: fx.home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(fallback).toEqual({
      authorName: "boof-runner",
      authorEmail: "boof-runner@localhost",
      committerName: "boof-runner",
      committerEmail: "boof-runner@localhost",
    });
  });

  it("grants section 5 git paths for a linked worktree and omits them for a main checkout", async () => {
    const linked = await fixture(true);
    const common = await repoCommonDir(linked.wtPath);
    expect(common).toBeTruthy();
    const policy = await buildRunPolicy(
      { runner: { sandbox: sandboxSettings } },
      { ...linked.ctx, serverPort: 4319 },
    );
    expect(policy.readExec).toContain(common);
    expect(policy.readExec).toContain("/bin");
    const home = await realpath(linked.home);
    const worktree = await realpath(linked.wtPath);
    expect(policy.readWrite).toEqual(
      expect.arrayContaining([
        worktree,
        linked.temp,
        join(common!, "worktrees", "task-1"),
        join(common!, "objects"),
        join(common!, "refs", "heads", "boof-runner"),
        join(common!, "logs"),
      ]),
    );
    expect(policy.readWrite).not.toContain(join(common!, "config"));
    expect(policy.readWrite).not.toContain(join(common!, "hooks"));
    expect(policy.readWrite).not.toContain(join(common!, "info"));
    expect(policy.readWrite).not.toContain(join(common!, "refs", "heads"));
    expect(policy.readWrite).not.toContain(join(common!, "refs", "heads", "main"));
    expect(existsSync(join(common!, "refs", "heads", "boof-runner"))).toBe(true);
    expect(policy.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(policy.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(policy.env.GIT_AUTHOR_NAME).toBe("Ada Lovelace");
    expect(policy.env.GIT_AUTHOR_EMAIL).toBe("ada@example.com");
    expect(policy.env.HOME.endsWith("/home")).toBe(true);
    expect(policy.env.TMPDIR).toBe(linked.temp);
    expect(policy.env.XDG_CACHE_HOME.endsWith("/cache")).toBe(true);
    expect(policy.denyTcpPorts).toEqual([4319]);
    expect(policy.readWrite).not.toContain(home);
    expect(policy.readExec).not.toContain(home);
    expect(policy.readWrite.includes("/dev/null")).toBe(opens("/dev/null"));
    if (!opens("/dev/tty")) expect(policy.readWrite).not.toContain("/dev/tty");

    const main = await buildRunPolicy(
      { runner: { sandbox: sandboxSettings } },
      {
        ...linked.ctx,
        writableRoot: linked.repo,
      },
    );
    expect(main.readExec).not.toContain(common);
    expect(main.readWrite).not.toContain(join(common!, "objects"));
    expect(main.readWrite).not.toContain(join(common!, "refs", "heads", "boof-runner"));
    expect(main.denyTcpPorts).toEqual([]);
  });

  it("names a configured path that does not exist", async () => {
    const fx = await fixture(true);
    await expect(
      buildRunPolicy(
        {
          runner: {
            sandbox: { ...sandboxSettings, readPaths: ["/no/such-boof-i1e-path"] },
          },
        },
        fx.ctx,
      ),
    ).rejects.toThrow("read path does not exist: /no/such-boof-i1e-path");
  });
});
