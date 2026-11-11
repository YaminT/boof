import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SandboxUnavailableError,
  dataRootPaths,
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
  trustedCheckout?: string,
): Promise<{ commonDir: string; worktreeName: string } | undefined> {
  const dotGit = join(writableRoot, ".git");
  let info;
  try {
    info = await lstat(dotGit);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SandboxUnavailableError("git worktree .git entry was altered");
  }
  const text = await readFile(dotGit, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)\s*$/.exec(text.trim());
  if (!match?.[1]) throw new SandboxUnavailableError("git worktree .git file was altered");
  const gitdir = await realpath(resolve(writableRoot, match[1])).catch(() => null);
  if (!gitdir) throw new SandboxUnavailableError("git worktree gitdir was altered");
  const name = basename(gitdir);
  if (basename(dirname(gitdir)) !== "worktrees") {
    throw new SandboxUnavailableError("git worktree gitdir is outside the runner worktree record");
  }
  if (name !== basename(writableRoot)) {
    throw new SandboxUnavailableError(
      "git worktree gitdir differs from the runner worktree record",
    );
  }
  const common = trustedCheckout
    ? await repoCommonDir(trustedCheckout)
    : await repoCommonDir(writableRoot);
  if (!common) return undefined;
  const expected = await realpath(join(common, "worktrees", name)).catch(() => null);
  if (expected !== gitdir) {
    throw new SandboxUnavailableError("git worktree admin directory does not match the common dir");
  }
  const gitdirFile = join(gitdir, "gitdir");
  const gitdirInfo = await lstat(gitdirFile).catch(() => null);
  if (!gitdirInfo?.isFile() || gitdirInfo.isSymbolicLink()) {
    throw new SandboxUnavailableError("git worktree admin gitdir entry was altered");
  }
  const registeredPath = await realpath(
    resolve(gitdir, (await readFile(gitdirFile, "utf8")).trim()),
  ).catch(() => null);
  if (registeredPath !== (await realpath(dotGit))) {
    throw new SandboxUnavailableError(
      "git worktree admin gitdir does not match the runner worktree record",
    );
  }
  const commondirPath = join(gitdir, "commondir");
  const commondirInfo = await lstat(commondirPath).catch(() => null);
  if (!commondirInfo?.isFile() || commondirInfo.isSymbolicLink()) {
    throw new SandboxUnavailableError("git worktree commondir entry was altered");
  }
  const commondir = await realpath(
    resolve(gitdir, (await readFile(commondirPath, "utf8")).trim()),
  ).catch(() => null);
  if (commondir !== (await realpath(common))) {
    throw new SandboxUnavailableError(
      "git worktree commondir does not match the runner worktree record",
    );
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
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new SandboxUnavailableError(`sandbox directory is not a real directory: ${path}`);
  }
  await chmod(path, 0o700);
  return realDir(path);
}

async function checkedAgentState(agentHome: string, tool: string): Promise<Record<string, string>> {
  const root = join(agentHome, tool);
  const dirs = [
    root,
    ...["claude", "codex", "xdg-config", "xdg-data", "xdg-state"].map((n) => join(root, n)),
  ];
  for (const path of dirs) {
    await mkdir(path, { recursive: true });
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new SandboxUnavailableError(`agent state path must be a real directory: ${path}`);
    }
    const real = await realpath(path);
    const relative = resolve(agentHome) === real ? "" : relativePath(agentHome, real);
    if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
      throw new SandboxUnavailableError(`agent state path escapes agent home: ${path}`);
    }
    await chmod(path, 0o700);
  }
  return {
    CLAUDE_CONFIG_DIR: await realpath(join(root, "claude")),
    CODEX_HOME: await realpath(join(root, "codex")),
    XDG_CONFIG_HOME: await realpath(join(root, "xdg-config")),
    XDG_DATA_HOME: await realpath(join(root, "xdg-data")),
    XDG_STATE_HOME: await realpath(join(root, "xdg-state")),
  };
}

function relativePath(from: string, to: string): string {
  if (resolve(from) === to) return "";
  return relative(from, to);
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
  const livePort = ctx.serverPort ?? (await liveServerPort(dataRoot, env));
  const home = await realDir(userHome(env));
  const writableRoot = await realDir(ctx.writableRoot);
  const tempDir = await realDir(ctx.runTempDir);
  if (!RUN_TEMP.test(tempDir)) {
    throw new SandboxUnavailableError("run temp directory is not a private run folder");
  }
  const projectDir = await agentProjectDir(dataRoot, ctx.projectId, env);
  const agentHome = await makePrivate(join(projectDir, "home"));
  const projectEntry = await lstat(projectDir);
  if (projectEntry.isSymbolicLink() || !projectEntry.isDirectory()) {
    throw new SandboxUnavailableError(`agent project path is not a real directory: ${projectDir}`);
  }
  await chmod(projectDir, 0o700);
  const cacheDir = await makePrivate(join(projectDir, "cache"));
  const tool = ctx.tool;
  const toolStatePaths = await checkedAgentState(agentHome, tool);
  const gitFacts = await linkedWorktreeGit(writableRoot, ctx.mainCheckout);
  const gitObjects = gitFacts
    ? {
        privateDir: join(tempDir, "git-objects"),
        alternateDir: join(gitFacts.commonDir, "objects"),
      }
    : undefined;
  if (gitObjects) await mkdir(gitObjects.privateDir, { recursive: true, mode: 0o700 });
  const identity = await readGitIdentity(ctx.mainCheckout, env);
  const toolchain = await existingDirs(TOOLCHAIN_RELATIVE_PATHS.map((rel) => join(home, rel)));
  const policyCtx: SandboxPolicyContext = {
    platform,
    dataRoot,
    home,
    serverRunning: livePort !== undefined,
    boofPorts: livePort !== undefined ? [livePort] : [],
    readPaths: await configuredPaths(sandbox.readPaths, "read path"),
    writePaths: await configuredPaths(sandbox.writePaths, "write path"),
    denyTcpPorts: sandbox.denyTcpPorts,
    // Resolve symlinked system-root aliases before the helper opens rules with RESOLVE_NO_SYMLINKS.
    systemPaths:
      platform === "win32"
        ? []
        : (
            await Promise.all(
              systemRoots(platform)
                .filter((path) => pathOpens(path))
                .map((path) => realpath(path).catch(() => null)),
            )
          ).filter((path): path is string => path !== null),
    pathEntries: await resolvePathEntries(env.PATH),
    toolInstallRoot: await toolInstallRoot(tool, env),
    toolchainPaths: toolchain,
    writableRoot,
    tempDir,
    agentHome,
    cacheDir,
    toolStatePaths,
    credentialMode: "key",
    tool,
    devices: await Promise.all(
      existingDevices().map((path) => realpath(path).catch(() => "")),
    ).then((paths) => paths.filter(Boolean)),
    ...(gitFacts ? { git: gitFacts } : {}),
    ...(gitObjects ? { gitObjects } : {}),
    ...(identity ? { gitIdentity: identity } : {}),
  };
  try {
    return buildSandboxPolicy(policyCtx);
  } catch (err) {
    if (err instanceof SandboxPolicyError) throw new SandboxUnavailableError(err.message);
    throw err;
  }
}

async function liveServerPort(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<number | undefined> {
  const path = dataRootPaths(dataRoot).serverPort;
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (text === null) {
    const configured = env.BOOF_RUNNER_PORT ?? "4319";
    const port = Number(configured);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxUnavailableError("boof server port is unknown; refusing sandbox launch");
    }
    return (await portIsListening(port)) ? port : undefined;
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    throw new SandboxUnavailableError(
      "boof server port record is invalid; refusing sandbox launch",
    );
  }
  if (
    typeof record !== "object" ||
    record === null ||
    !Number.isInteger((record as { pid?: unknown }).pid) ||
    !Number.isInteger((record as { port?: unknown }).port) ||
    (record as { pid: number }).pid < 1 ||
    (record as { port: number }).port < 1 ||
    (record as { port: number }).port > 65535
  )
    throw new SandboxUnavailableError(
      "boof server port record is invalid; refusing sandbox launch",
    );
  const pid = (record as { pid: number }).pid;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return undefined;
  }
  return (record as { port: number }).port;
}

function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (listening: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
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

/** Verify and import new objects from the run-private object store without replacing shared ones. */
export async function importPrivateGitObjects(opts: {
  runTempDir: string;
  writableRoot: string;
  mainCheckout: string;
}): Promise<void> {
  const gitFacts = await linkedWorktreeGit(opts.writableRoot, opts.mainCheckout);
  if (!gitFacts) return;
  const commonDir = await repoCommonDir(opts.mainCheckout);
  if (!commonDir) return;
  const source = join(opts.runTempDir, "git-objects");
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo) return;
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new SandboxUnavailableError("private git object directory was altered");
  }
  // Detach the private store from the sandbox policy before reading it. A surviving agent
  // process cannot swap object directories while the import walks them.
  const detached = join(
    dirname(opts.runTempDir),
    `.${basename(opts.runTempDir)}-git-import-${randomBytes(RUN_ID_BYTES).toString("hex")}`,
  );
  await rename(source, detached);
  const snapshot = await mkdtemp(join(tmpdir(), "boof-git-objects-"));
  try {
    const detachedInfo = await lstat(detached);
    if (detachedInfo.isSymbolicLink() || !detachedInfo.isDirectory()) {
      throw new SandboxUnavailableError("detached private git object directory was altered");
    }
    for (const prefix of await readdir(detached)) {
      if (!/^[0-9a-f]{2}$/.test(prefix) && prefix !== "pack" && prefix !== "info") continue;
      const fromDir = join(detached, prefix);
      const info = await lstat(fromDir);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      const toDir = join(snapshot, prefix);
      await mkdir(toDir, { recursive: true, mode: 0o700 });
      for (const name of await readdir(fromDir)) {
        const file = join(fromDir, name);
        const item = await lstat(file);
        if (item.isSymbolicLink() || !item.isFile()) continue;
        if (prefix !== "pack" && !/^[0-9a-f]{38,62}$/.test(name)) continue;
        if (prefix === "pack" && !/^pack-[0-9a-f]{40,64}\.(pack|idx|bitmap|rev)$/.test(name))
          continue;
        await copyFile(file, join(toDir, name));
      }
    }
    const env = {
      ...process.env,
      GIT_OBJECT_DIRECTORY: snapshot,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const verified = await git(
      opts.writableRoot,
      ["fsck", "--full", "--strict", "--no-reflogs"],
      env,
    );
    if (verified.code !== 0) {
      throw new SandboxUnavailableError(
        `private git objects failed verification: ${verified.err || verified.out}`,
      );
    }
    for (const prefix of await readdir(snapshot)) {
      const fromDir = join(snapshot, prefix);
      const toDir = join(commonDir, "objects", prefix);
      await mkdir(toDir, { recursive: true });
      for (const name of await readdir(fromDir)) {
        try {
          await copyFile(join(fromDir, name), join(toDir, name), constants.COPYFILE_EXCL);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
    }
  } finally {
    await rm(snapshot, { recursive: true, force: true });
    await rm(detached, { recursive: true, force: true });
  }
}
