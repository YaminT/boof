import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  SandboxUnavailableError,
  git,
  isGitRepo,
  isKebabId,
  repoCommonDir,
  type CommandLaunch,
} from "@boof/heart";
import { boofSandboxHelperPath } from "./backend-linux.js";
import {
  DARWIN_SYSTEM_ROOTS,
  LINUX_LIB_PATHS,
  LINUX_SYSTEM_ROOTS,
  SANDBOX_DEVICES,
  SandboxPolicyError,
  TOOLCHAIN_RELATIVE_PATHS,
  buildSandboxPolicy,
  type SandboxGitIdentity,
  type SandboxPolicy,
  type SandboxPolicyContext,
} from "./policy.js";

export interface SandboxSettingsInput {
  mode: "off" | "enforce";
  readPaths: readonly string[];
  writePaths: readonly string[];
  denyTcpPorts: readonly number[];
}

/**
 * Filesystem facts for one enforced run. The policy builder stays pure; this module creates the
 * boof-owned directories and reads git.
 *
 * Decisions, where the design leaves a choice:
 * - Credential mode is `key`. Login mode stays refused: the writable credential paths are not proven.
 * - A main checkout (`.git` is a directory) omits the section 5 rules. Those rules need a common
 *   dir outside the writable folder, and Landlock cannot keep hooks read-only under a writable parent.
 * - When `git var` cannot produce a name and email, the identity is `boof-runner` /
 *   `boof-runner@localhost`, the same fallback `commitLeftovers` uses.
 * - The boof port is the in-process server's bound port. A run with no server in this process does
 *   not guess one. The desktop app uses that same port, so it is not added a second time.
 * - `refs/heads/boof-runner` is created when it is missing, so the write rule has a directory to
 *   bind to. The helper refuses to start when a granted path does not exist.
 * - A system root or device that exists but cannot be opened is left out. The helper aborts the
 *   whole launch if any granted path fails to open, and a headless server often cannot open
 *   `/dev/tty`. Configured read and write paths still fail closed when they are missing.
 */

const RUN_ID_BYTES = 8;
const FALLBACK_IDENTITY: SandboxGitIdentity = {
  authorName: "boof-runner",
  authorEmail: "boof-runner@localhost",
  committerName: "boof-runner",
  committerEmail: "boof-runner@localhost",
};

const IDENT_LINE = /^(.+) <([^>\s]+)> \d+ [+-]\d{4}$/;
const RUN_TEMP =
  /\/boof-runner\/agents\/[0-9a-f]{64}\/[a-z0-9]+(?:-[a-z0-9]+)*\/runs\/[0-9a-f]{16}$/;

export interface AgentLaunchContext {
  /** Real data root, or a path this module will realpath. */
  dataRoot: string;
  /** Kebab-case project id. It becomes one directory name under the state folder. */
  projectId: string;
  /** Tool id (`claude-code`, `codex`, `opencode`, `claude-agent`, `mock`, …). */
  tool: string;
  /** Task worktree, or the project folder when the project has no worktree. */
  writableRoot: string;
  /** Main checkout. Git identity is read here, and a linked worktree's common dir is found from it. */
  mainCheckout: string;
  /** Per-run temp directory from {@link createRunTemp}. Already mode 700. */
  runTempDir: string;
  /** Bound port of the server in this process. Omit when this process is not listening. */
  serverPort?: number;
  /**
   * Where `HOME`, `PATH` and `XDG_STATE_HOME` are read from. Defaults to `process.env`.
   * Tests pass a scratch home and state directory.
   */
  env?: NodeJS.ProcessEnv;
  /** Helper binary. Defaults to {@link boofSandboxHelperPath}. */
  helper?: string;
}

/** `$XDG_STATE_HOME/boof-runner`, or `~/.local/state/boof-runner` when the variable is unset. */
export function boofStateHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  if (typeof xdg === "string" && xdg.startsWith("/") && !xdg.includes("\0")) {
    return join(xdg, "boof-runner");
  }
  return join(userHome(env), ".local", "state", "boof-runner");
}

function userHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (typeof home === "string" && home.startsWith("/") && !home.includes("\0")) return home;
  return homedir();
}

export async function dataRootHash(dataRoot: string): Promise<string> {
  return createHash("sha256")
    .update(await realpath(dataRoot))
    .digest("hex");
}

function projectSegment(projectId: string): string {
  if (!isKebabId(projectId)) {
    throw new SandboxUnavailableError(`project id "${projectId}" is not kebab-case`);
  }
  return projectId;
}

async function agentProjectDir(
  dataRoot: string,
  projectId: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const hash = await dataRootHash(dataRoot);
  return join(boofStateHome(env), "agents", hash, projectSegment(projectId));
}

/**
 * Create the per-run temp directory, mode 700. The runner removes it when the run ends.
 * A crash leaves it for {@link reapCrashedRunTemps} at the next server start.
 */
export async function createRunTemp(opts: {
  dataRoot: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = opts.env ?? process.env;
  const projectDir = await agentProjectDir(opts.dataRoot, opts.projectId, env);
  const runsDir = join(projectDir, "runs");
  const id = randomBytes(RUN_ID_BYTES).toString("hex");
  const dir = join(runsDir, id);
  await mkdir(dir, { recursive: true });
  // `mkdir` applies the umask, so the mode has to be set again. The project directory is
  // boof-owned; the state home above it is left as the user created it.
  await chmod(dir, 0o700);
  await chmod(runsDir, 0o700);
  await chmod(projectDir, 0o700);
  const real = await realpath(dir);
  if (!RUN_TEMP.test(real)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new SandboxUnavailableError("run temp directory escaped its state folder");
  }
  return real;
}

/** Remove one run temp directory. Refuses any path that is not a run directory this module created. */
export async function removeRunTemp(dir: string): Promise<void> {
  const real = await realpath(dir).catch(() => null);
  if (!real || !RUN_TEMP.test(real)) return;
  await rm(real, { recursive: true, force: true });
}

/**
 * Delete leftover per-run temp directories for this data root. Home and cache stay.
 * Called at server start: a crashed run never reached {@link removeRunTemp}.
 * Another data root's directories are left alone.
 */
export async function reapCrashedRunTemps(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let hash: string;
  try {
    hash = await dataRootHash(dataRoot);
  } catch {
    return;
  }
  const agents = join(boofStateHome(env), "agents", hash);
  let projects: string[];
  try {
    projects = await readdir(agents);
  } catch {
    return;
  }
  for (const project of projects) {
    if (!isKebabId(project)) continue;
    await rm(join(agents, project, "runs"), { recursive: true, force: true }).catch(() => {});
  }
}

function parseIdent(line: string): { name: string; email: string } | undefined {
  const match = IDENT_LINE.exec(line.trim());
  if (!match) return undefined;
  const name = match[1];
  const email = match[2];
  if (!name || !email || /[\0\r\n]/.test(name) || /[\0\r\n]/.test(email)) return undefined;
  return { name, email };
}

/**
 * Author and committer from `git var` in the main checkout. The server can still see
 * `~/.gitconfig`; the sandbox then sets `GIT_CONFIG_GLOBAL=/dev/null`.
 */
export async function readGitIdentity(
  checkout: string,
  env?: NodeJS.ProcessEnv,
): Promise<SandboxGitIdentity | undefined> {
  if (!(await isGitRepo(checkout))) return undefined;
  const authorRun = await git(checkout, ["var", "GIT_AUTHOR_IDENT"], env);
  const committerRun = await git(checkout, ["var", "GIT_COMMITTER_IDENT"], env);
  const author = authorRun.code === 0 ? parseIdent(authorRun.out) : undefined;
  const committer = committerRun.code === 0 ? parseIdent(committerRun.out) : undefined;
  if (!author && !committer) return { ...FALLBACK_IDENTITY };
  return {
    authorName: author?.name ?? FALLBACK_IDENTITY.authorName,
    authorEmail: author?.email ?? FALLBACK_IDENTITY.authorEmail,
    committerName: committer?.name ?? FALLBACK_IDENTITY.committerName,
    committerEmail: committer?.email ?? FALLBACK_IDENTITY.committerEmail,
  };
}

/**
 * Section 5 facts for a linked worktree. A main checkout returns undefined: its common dir sits
 * inside the writable folder, so the read-only git rules cannot be applied.
 */
export async function linkedWorktreeGit(
  writableRoot: string,
): Promise<{ commonDir: string; worktreeName: string } | undefined> {
  const dotGit = join(writableRoot, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) return undefined;
  const text = await readFile(dotGit, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)\s*$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  const gitdir = await realpath(resolve(writableRoot, match[1]));
  const name = basename(gitdir);
  if (basename(dirname(gitdir)) !== "worktrees") return undefined;
  const common = await repoCommonDir(writableRoot);
  if (!common) return undefined;
  const expected = await realpath(join(common, "worktrees", name)).catch(() => null);
  if (expected !== gitdir) {
    throw new SandboxUnavailableError("git worktree admin directory does not match the common dir");
  }
  await ensureGitWriteDirs(common, name);
  return { commonDir: common, worktreeName: name };
}

async function ensureGitWriteDirs(commonDir: string, worktreeName: string): Promise<void> {
  const required = [
    join(commonDir, "worktrees", worktreeName),
    join(commonDir, "objects"),
    join(commonDir, "logs"),
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      throw new SandboxUnavailableError(`git path is missing: ${path}`);
    }
  }
  const refs = join(commonDir, "refs", "heads", "boof-runner");
  if (!existsSync(refs)) await mkdir(refs, { recursive: true });
}

async function realDir(path: string): Promise<string> {
  const real = await realpath(path);
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new SandboxUnavailableError(`sandbox path is not a directory: ${path}`);
  }
  return real;
}

async function makePrivate(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await chmod(path, 0o700);
  return realDir(path);
}

async function existingDirs(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const real = await realDir(path);
      if (!out.includes(real)) out.push(real);
    } catch {
      /* unreadable or not a directory */
    }
  }
  return out;
}

/**
 * True when this process can open `path` the way the helper does (`O_PATH`). A path that merely
 * exists, such as `/dev/tty` with no controlling terminal, would make the helper exit 126.
 */
function pathOpens(path: string): boolean {
  if (!existsSync(path)) return false;
  // O_PATH is Linux-only and missing from the shared Node types.
  const osConstants = constants as typeof constants & { O_PATH?: number; O_CLOEXEC?: number };
  if (typeof osConstants.O_PATH !== "number") return true;
  try {
    const fd = openSync(path, osConstants.O_PATH | (osConstants.O_CLOEXEC ?? 0));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function existingDevices(): string[] {
  return SANDBOX_DEVICES.filter((path) => pathOpens(path));
}

function systemRoots(platform: "linux" | "darwin"): readonly string[] {
  if (platform === "darwin") return DARWIN_SYSTEM_ROOTS;
  return [...LINUX_SYSTEM_ROOTS.slice(0, 3), ...LINUX_LIB_PATHS, ...LINUX_SYSTEM_ROOTS.slice(3)];
}

async function resolvePathEntries(pathEnv: string | undefined): Promise<string[]> {
  if (!pathEnv) return [];
  const entries: string[] = [];
  for (const entry of pathEnv.split(":")) {
    if (!entry.startsWith("/") || entry.includes("\0")) continue;
    entries.push(entry);
  }
  return existingDirs(entries);
}

function toolCommand(tool: string, env: NodeJS.ProcessEnv): string | undefined {
  if (tool === "claude-code") return env.BOOF_RUNNER_CLAUDE_BIN || "claude";
  if (tool === "codex") return env.BOOF_RUNNER_CODEX_BIN || "codex";
  if (tool === "opencode") return env.BOOF_RUNNER_OPENCODE_BIN || "opencode";
  if (tool === "claude-agent") {
    return env.BOOF_RUNNER_CLAUDE_AGENT_BIN || env.BOOF_RUNNER_CLAUDE_BIN || "claude";
  }
  if (tool === "mock") return process.execPath;
  return undefined;
}

function commandOnPath(command: string, pathEnv: string | undefined): string | undefined {
  if (command.includes("\0") || command.includes("/")) {
    return command.startsWith("/") && existsSync(command) ? command : undefined;
  }
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(":")) {
    if (!dir.startsWith("/")) continue;
    const full = join(dir, command);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function toolInstallRoot(tool: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const command = toolCommand(tool, env);
  if (!command) return undefined;
  const found = commandOnPath(command, env.PATH);
  if (!found) return undefined;
  try {
    const resolved = await realpath(found);
    const binName = basename(command);
    // Package launchers often resolve to <package>/bin/<tool>, then spawn a native executable
    // from a sibling `vendor` or nested dependency directory. Granting dirname(resolved) misses
    // that executable. Find the package that declares this CLI in its `bin` map and grant only
    // that package directory. Starting from realpath(found) also makes symlinked npm/bun bins
    // resolve to the owning package before we inspect its manifest.
    let directory = dirname(resolved);
    while (true) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
          bin?: string | Record<string, string>;
        };
        const bins = typeof manifest.bin === "string" ? { [tool]: manifest.bin } : manifest.bin;
        if (bins && Object.hasOwn(bins, binName)) return directory;
      } catch {
        // Keep walking: not every directory in the resolved path is a package root.
      }
      const parent = dirname(directory);
      if (parent === directory) return dirname(resolved);
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

async function configuredPaths(paths: readonly string[], label: string): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new SandboxUnavailableError(`${label} does not exist: ${path}`);
    }
    out.push(await realDir(path));
  }
  return out;
}

function sandboxPlatform(platform: NodeJS.Platform): SandboxPolicyContext["platform"] {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  throw new SandboxUnavailableError(`unsupported sandbox platform "${platform}"`);
}

/** Build the enforce policy for one step. Creates the agent home, cache and tool-state directories. */
export async function buildRunPolicy(
  settings: { runner: { sandbox: SandboxSettingsInput } },
  ctx: AgentLaunchContext,
): Promise<SandboxPolicy> {
  const env = ctx.env ?? process.env;
  const platform = sandboxPlatform(process.platform);
  const sandbox = settings.runner.sandbox;
  const dataRoot = await realDir(ctx.dataRoot);
  const home = await realDir(userHome(env));
  const writableRoot = await realDir(ctx.writableRoot);
  const tempDir = await realDir(ctx.runTempDir);
  if (!RUN_TEMP.test(tempDir)) {
    throw new SandboxUnavailableError("run temp directory is not a private run folder");
  }
  const projectDir = await agentProjectDir(dataRoot, ctx.projectId, env);
  const agentHome = await makePrivate(join(projectDir, "home"));
  await chmod(projectDir, 0o700);
  const cacheDir = await makePrivate(join(projectDir, "cache"));
  const tool = ctx.tool;
  for (const name of ["claude", "codex", "xdg-config", "xdg-data", "xdg-state"]) {
    await makePrivate(join(agentHome, tool, name));
  }
  const gitFacts = await linkedWorktreeGit(writableRoot);
  const identity = await readGitIdentity(ctx.mainCheckout, env);
  const toolchain = await existingDirs(TOOLCHAIN_RELATIVE_PATHS.map((rel) => join(home, rel)));
  const policyCtx: SandboxPolicyContext = {
    platform,
    dataRoot,
    home,
    serverRunning: ctx.serverPort !== undefined,
    boofPorts: ctx.serverPort !== undefined ? [ctx.serverPort] : [],
    readPaths: await configuredPaths(sandbox.readPaths, "read path"),
    writePaths: await configuredPaths(sandbox.writePaths, "write path"),
    denyTcpPorts: sandbox.denyTcpPorts,
    // Literal paths, not realpaths. On a merged /usr, realpath("/bin") is "/usr/bin", which is not
    // a system root, so the builder would drop it and the shell would be unreadable.
    systemPaths:
      platform === "win32" ? [] : systemRoots(platform).filter((path) => pathOpens(path)),
    pathEntries: await resolvePathEntries(env.PATH),
    toolInstallRoot: await toolInstallRoot(tool, env),
    toolchainPaths: toolchain,
    writableRoot,
    tempDir,
    agentHome,
    cacheDir,
    credentialMode: "key",
    tool,
    devices: existingDevices(),
    ...(gitFacts ? { git: gitFacts } : {}),
    ...(identity ? { gitIdentity: identity } : {}),
  };
  try {
    return buildSandboxPolicy(policyCtx);
  } catch (err) {
    if (err instanceof SandboxPolicyError) throw new SandboxUnavailableError(err.message);
    throw err;
  }
}

async function refuseUnsafeOpenCodePortZero(policy: SandboxPolicy, tool: string): Promise<void> {
  if (process.platform !== "linux" || tool !== "opencode") return;
  let range: string;
  try {
    range = await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
  } catch {
    throw new SandboxUnavailableError("a denied port is in the ephemeral range");
  }
  const match = /^(\d+)\s+(\d+)\s*$/.exec(range);
  const first = match ? Number(match[1]) : NaN;
  const last = match ? Number(match[2]) : NaN;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last < first ||
    last > 65535
  ) {
    throw new SandboxUnavailableError("a denied port is in the ephemeral range");
  }
  if (policy.denyTcpPorts.some((port) => port >= first && port <= last)) {
    throw new SandboxUnavailableError("a denied port is in the ephemeral range");
  }
}

/** Sandbox launch for one step, or `direct` when the caller asked for direct. */
export async function sandboxLaunchFor(
  settings: { runner: { sandbox: SandboxSettingsInput } },
  ctx: AgentLaunchContext,
): Promise<Extract<CommandLaunch, { kind: "sandbox" }>> {
  const env = ctx.env ?? process.env;
  const policy = await buildRunPolicy(settings, ctx);
  await refuseUnsafeOpenCodePortZero(policy, ctx.tool);
  return {
    kind: "sandbox",
    policy,
    helper: ctx.helper ?? boofSandboxHelperPath(env),
  };
}
