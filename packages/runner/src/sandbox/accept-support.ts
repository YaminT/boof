import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, it } from "vitest";
import {
  execCommand,
  resetSandboxStatus,
  sandboxSettingsFingerprint,
  setSandboxStatus,
  type ExecResult,
} from "@boof/heart";
import { createWorktree, type Worktree } from "../worktree.js";
import { prepareAgentLaunch, type SandboxSettingsView } from "./index.js";
import { createRunTemp, type AgentLaunchContext } from "./runtime.js";

export const linux = process.platform === "linux";
export const darwin = process.platform === "darwin";
export const sandboxRequired = process.env.BOOF_REQUIRE_SANDBOX === "1";

/** Landlock denies file and TCP access with EACCES. Seatbelt denies them with EPERM. */
export function sandboxErrno(): "EACCES" | "EPERM" {
  return darwin ? "EPERM" : "EACCES";
}

const here = dirname(fileURLToPath(import.meta.url));
const sandboxDir = join(here, "../../../sandbox-linux");
const dist = join(sandboxDir, "dist");
const helper = join(dist, "boof-sandbox");
const probeBuilt = join(dist, "probe");
const source = join(sandboxDir, "boof-sandbox.c");
const probeSource = join(sandboxDir, "probe.c");

const roots: string[] = [];
let abiCache = 0;

export interface AcceptFixture {
  base: string;
  env: NodeJS.ProcessEnv;
  data: string;
  repo: string;
  wt: Worktree;
  temp: string;
  probe: string;
  ctx: AgentLaunchContext;
  settings: SandboxSettingsView;
}

export interface ListenHandle {
  server: Server;
  port: number;
}

/**
 * One file per group of design rows A1–A18. Linux runs every row. macOS runs the rows from
 * design section 7 (A1–A9 and A12–A17); A10, A11 and A18 stay Linux-only at the call site.
 * Any other host skips the group, unless `BOOF_REQUIRE_SANDBOX=1`, which fails the run.
 */
export function sandboxSuite(title: string, body: () => void): void {
  const host = linux || darwin;
  describe.skipIf(!host && !sandboxRequired)(title, () => {
    if (!host) {
      it("fails closed when the sandbox is required", () => {
        throw new Error("BOOF_REQUIRE_SANDBOX=1 but this platform has no sandbox backend");
      });
      return;
    }

    beforeAll(() => {
      ensureSandboxBuilt();
    }, 60_000);

    afterEach(async () => {
      await resetAcceptance();
    });

    body();
  });
}

export function landlockAbi(): number {
  return abiCache;
}

export async function resetAcceptance(): Promise<void> {
  resetSandboxStatus();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function shQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function listen(host: string, port = 0): Promise<ListenHandle> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only: host.includes(":") }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

export function closeListen(handle: ListenHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Real enforce policy for one linked worktree: data root, git common dir, agent home, cache and
 * temp. `HOME` is this process's home so `~/.ssh` and `~/.claude.json` are the real ones and are
 * not granted. State is a scratch `XDG_STATE_HOME`, not the user's state directory.
 */
export async function makeFixture(
  settings: Partial<SandboxSettingsView> = {},
): Promise<AcceptFixture> {
  const base = await mkdtemp(join(tmpdir(), "boof-i1f-"));
  roots.push(base);
  const home = homedir();
  const data = join(base, "data");
  const repo = join(base, "repo");
  const wtRoot = join(base, "wt");
  const state = join(base, "state");
  await mkdir(join(data, "auth"), { recursive: true });
  await mkdir(join(data, "n8n"), { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(wtRoot, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(data, "settings.json"), '{"secret":true}\n');
  await writeFile(join(data, "auth", "token"), "token\n");
  await writeFile(join(data, "n8n", "secrets.json"), '{"k":1}\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: state,
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
  delete env.BOOF_SANDBOX_FAKE_ABI;
  await git(repo, ["init", "-b", "main"], env);
  await git(repo, ["config", "user.name", "Ada Lovelace"], env);
  await git(repo, ["config", "user.email", "ada@example.com"], env);
  await git(repo, ["config", "commit.gpgsign", "false"], env);
  await writeFile(join(repo, "README"), "hi\n");
  await git(repo, ["add", "README"], env);
  await git(repo, ["commit", "-m", "init"], env);
  // createWorktree's git calls read process.env, not the fixture env. Isolate them from the
  // owner's git config so a prompt or helper cannot hold the test open.
  const savedGit: Record<string, string | undefined> = {};
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"] as const) {
    savedGit[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.GIT_TERMINAL_PROMPT = "0";
  let wt: Worktree;
  try {
    wt = (await createWorktree(repo, "task-1", { root: wtRoot })).worktree;
  } finally {
    for (const key of Object.keys(savedGit)) {
      const value = savedGit[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await writeFile(join(wt.path, "visible.txt"), "visible\n");
  const probe = join(wt.path, "probe");
  await copyFile(probeBuilt, probe);
  await chmod(probe, 0o755);
  const temp = await createRunTemp({ dataRoot: data, projectId: "proj", env });
  const view: SandboxSettingsView = {
    mode: "enforce",
    readPaths: settings.readPaths ?? [],
    writePaths: settings.writePaths ?? [],
    denyTcpPorts: settings.denyTcpPorts ?? [],
  };
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
  return { base, env, data, repo, wt, temp, probe, ctx, settings: view };
}

/** Child started by `prepareAgentLaunch` and `execCommand`, the production launch path. */
export async function sandboxed(
  fx: AcceptFixture,
  command: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ExecResult> {
  setSandboxStatus(
    {
      mode: "enforce",
      backend: darwin ? "darwin" : "linux",
      state: "ok",
      reason: "",
    },
    sandboxSettingsFingerprint(fx.settings),
  );
  const launch = await prepareAgentLaunch({ runner: { sandbox: fx.settings } }, fx.ctx);
  if (launch.kind !== "sandbox") throw new Error("expected a sandbox launch");
  return execCommand(command, args, {
    cwd: opts.cwd ?? fx.wt.path,
    launch,
    env: { PATH: "/usr/bin:/bin", LANG: "C", ...opts.env },
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

export function runProbe(fx: AcceptFixture, args: string[]): Promise<ExecResult> {
  return sandboxed(fx, fx.probe, args);
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const res = await execCommand("git", args, {
    launch: { kind: "direct" },
    cwd,
    env,
    timeoutMs: 15_000,
  });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

function compileProbe(): void {
  const probeStale =
    !existsSync(probeBuilt) || statSync(probeBuilt).mtimeMs < statSync(probeSource).mtimeMs;
  if (!probeStale) return;
  const cc = process.env.CC || "cc";
  const compiled = spawnSync(
    cc,
    ["-O2", "-Wall", "-Wextra", "-Werror", "-o", probeBuilt, probeSource],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) {
    throw new Error(compiled.stderr || compiled.stdout || `cc ${probeSource} failed`);
  }
}

function ensureSandboxBuilt(): void {
  withBuildLock(() => {
    if (darwin) {
      compileProbe();
      return;
    }
    const helperStale = !existsSync(helper) || statSync(helper).mtimeMs < statSync(source).mtimeMs;
    if (helperStale) {
      const built = spawnSync(process.execPath, [join(sandboxDir, "build.mjs")], {
        encoding: "utf8",
      });
      if (built.status !== 0) {
        throw new Error(built.stderr || built.stdout || "build.mjs failed");
      }
    }
    if (!existsSync(helper)) {
      throw new Error("boof-sandbox helper was not built");
    }
    compileProbe();
    const abiRun = spawnSync(helper, ["--abi"], { encoding: "utf8" });
    if (abiRun.status !== 0) {
      throw new Error(abiRun.stderr || "boof-sandbox --abi failed");
    }
    abiCache = Number(abiRun.stdout.trim());
    if (!Number.isInteger(abiCache) || abiCache < 4) {
      throw new Error(`landlock abi ${abiRun.stdout.trim()} is below 4`);
    }
  });
}

function withBuildLock(fn: () => void): void {
  mkdirSync(dist, { recursive: true });
  const lock = join(dist, ".build.lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true });
      } catch {
        /* the other build removed it */
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the sandbox build lock");
      spawnSync("sleep", ["0.05"]);
    }
  }
  try {
    fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
