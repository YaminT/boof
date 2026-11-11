import { posix } from "node:path";

/**
 * The sandbox policy a launcher applies. Everything not listed is denied. Paths are realpaths:
 * a symlink inside the worktree that points outside is denied by the kernel, because rules bind
 * to the real target. This module does not touch the filesystem; the caller passes those facts.
 *
 * Login mode is refused. The I1a spike did not prove which credential, session or log paths a
 * tool must write, and a writable settings or hooks file would plant a hook that the owner's
 * next interactive session runs outside the sandbox. macOS is refused as well: the credentials
 * live in the Keychain, and opening the Keychain opens all of it.
 */

export const SANDBOX_POLICY_VERSION = 1 as const;

/** Linux read+execute roots, in policy order. `/lib*` is {@link LINUX_LIB_PATHS}. */
export const LINUX_SYSTEM_ROOTS = [
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/opt",
  "/nix",
  "/snap",
  "/proc",
  "/sys",
  "/run/systemd/resolve",
] as const;

/** Directories matching the design's `/lib*`, and no others (`/library` is not one). */
export const LINUX_LIB_PATHS = ["/lib", "/lib64", "/lib32", "/libx32"] as const;

/** macOS read+execute roots, in policy order. `/dev` is read-only here; the device list is writable. */
export const DARWIN_SYSTEM_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library",
  "/opt/homebrew",
  "/private/etc",
  "/private/var/db/timezone",
  "/dev",
] as const;

/**
 * Device nodes the sandbox may write. `/dev/null` is writable because Claude's shell probes open
 * it read-write (I1a). `/dev/shm` is not in this list.
 */
export const SANDBOX_DEVICES = [
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/ptmx",
  "/dev/pts",
] as const;

/** Toolchain directories under the real home, relative, that stay read-only when they exist. */
export const TOOLCHAIN_RELATIVE_PATHS = [
  ".rustup",
  ".cargo/bin",
  ".nvm",
  ".volta",
  "go/bin",
] as const;

const PRIVATE_TEMP_ROOTS = new Set(["/tmp", "/var/tmp", "/private/tmp", "/dev/shm"]);

export type SandboxPlatform = "linux" | "darwin" | "win32";
export type SandboxCredentialMode = "key" | "login";

export type SandboxPolicyErrorCode =
  | "windows_unsupported"
  | "unsupported_platform"
  | "login_mode_refused"
  | "boof_port_unknown"
  | "invalid_port"
  | "invalid_path"
  | "invalid_tool"
  | "invalid_git"
  | "invalid_identity"
  | "writable_contains_data_root"
  | "writable_is_home"
  | "allowed_path_overlaps_data_root"
  | "allowed_path_is_home"
  | "path_overlaps_data_root"
  | "path_is_home"
  | "temp_not_private"
  | "git_inside_writable";

export class SandboxPolicyError extends Error {
  constructor(
    public readonly code: SandboxPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export interface SandboxGitIdentity {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

/**
 * Filesystem facts for one agent run. Every path is already a realpath. The builder does not
 * look at the disk, so tests pass plain strings.
 */
export interface SandboxPolicyContext {
  platform: SandboxPlatform;
  /** Realpath of the boof data root. A granted path must not contain it or sit inside it. */
  dataRoot: string;
  /** The user's real home. It is not granted. The sandbox `HOME` is `agentHome`. */
  home: string;
  /** True while a boof server is listening. An empty `boofPorts` then refuses the policy. */
  serverRunning: boolean;
  /** Boof server ports of this data root. Copied into `denyTcpPorts` even when the user lists none. */
  boofPorts: readonly number[];
  /** Desktop app port, when one is open. */
  desktopPort?: number;
  /** `runner.sandbox.readPaths`. */
  readPaths: readonly string[];
  /** `runner.sandbox.writePaths`. */
  writePaths: readonly string[];
  /** `runner.sandbox.denyTcpPorts`. Extra ports only; the boof port is added separately. */
  denyTcpPorts: readonly number[];
  /** System roots that exist, from {@link isSandboxSystemPath}. Anything else is ignored. */
  systemPaths: readonly string[];
  /** Realpaths of the agent `PATH` entries, in order. */
  pathEntries: readonly string[];
  /** Directory that contains the resolved tool binary. */
  toolInstallRoot?: string;
  /** Toolchain directories that exist (`~/.rustup`, `~/.cargo/bin`, and the rest of the list). */
  toolchainPaths: readonly string[];
  /** Task worktree, or the project folder when the project has no worktree. */
  writableRoot: string;
  /** Per-run temp directory (mode 700). Not `/tmp` or `/var/tmp` themselves. */
  tempDir: string;
  /** `<state>/agents/<rootHash>/<project>/home`. */
  agentHome: string;
  /** `<state>/agents/<rootHash>/<project>/cache`. */
  cacheDir: string;
  credentialMode: SandboxCredentialMode;
  /** Tool id: `claude-code`, `claude-agent`, `codex`, `opencode`, `mock`, or another single segment. */
  tool: string;
  /** Device nodes that exist, from {@link SANDBOX_DEVICES}. Others are ignored. */
  devices: readonly string[];
  /**
   * Linked worktree's common git directory. Omit for a project without a worktree. The common
   * dir must sit outside `writableRoot`, or hooks and config could not be kept read-only.
   */
  git?: { commonDir: string; worktreeName: string };
  /** From `git var` in the main checkout. Omit when the project is not a git repository. */
  gitIdentity?: SandboxGitIdentity;
}

export interface SandboxPolicy {
  version: typeof SANDBOX_POLICY_VERSION;
  /** Read and execute. */
  readExec: string[];
  /** Read and write. */
  readWrite: string[];
  denyTcpPorts: number[];
  /** Variables the launcher adds or replaces. */
  env: Record<string, string>;
}

/** True when `path` is one of the read+execute roots for `platform` (including `/lib*`). */
export function isSandboxSystemPath(platform: "linux" | "darwin", path: string): boolean {
  const normalized = normalizeIfAbsolute(path);
  if (normalized === null) return false;
  if (platform === "linux" && (LINUX_LIB_PATHS as readonly string[]).includes(normalized))
    return true;
  const roots = platform === "linux" ? LINUX_SYSTEM_ROOTS : DARWIN_SYSTEM_ROOTS;
  return (roots as readonly string[]).includes(normalized);
}

export function buildSandboxPolicy(ctx: SandboxPolicyContext): SandboxPolicy {
  const platform = sandboxPlatform(ctx.platform);
  const tool = toolSegment(ctx.tool);
  if (ctx.credentialMode === "login") refuseLogin(platform, tool);
  if (ctx.serverRunning && ctx.boofPorts.length === 0) {
    throw new SandboxPolicyError(
      "boof_port_unknown",
      "the boof port is unknown while a server is running",
    );
  }

  const dataRoot = mustPath(ctx.dataRoot, "data root");
  const home = mustPath(ctx.home, "home");
  const writableRoot = mustPath(ctx.writableRoot, "writable folder");
  const tempDir = mustPath(ctx.tempDir, "temp directory");
  const agentHome = mustPath(ctx.agentHome, "agent home");
  const cacheDir = mustPath(ctx.cacheDir, "cache directory");
  const readPaths = ctx.readPaths.map((p) => mustPath(p, "allowed path"));
  const writePaths = ctx.writePaths.map((p) => mustPath(p, "allowed path"));

  // The worktree (or the project folder, when there is no worktree) must not hold the data root.
  // A folder inside the data root is the same hole, so that is refused too.
  assertWritable(writableRoot, dataRoot, home);
  if (PRIVATE_TEMP_ROOTS.has(tempDir)) {
    throw new SandboxPolicyError(
      "temp_not_private",
      `temp directory "${tempDir}" must be a private folder, not a shared temp directory`,
    );
  }
  assertPrivateDir("agent home", agentHome, dataRoot, home);
  assertPrivateDir("cache directory", cacheDir, dataRoot, home);
  assertPrivateDir("temp directory", tempDir, dataRoot, home);
  for (const path of readPaths) assertAllowedPath(path, dataRoot, home);
  for (const path of writePaths) assertAllowedPath(path, dataRoot, home);

  const installRoot = ctx.toolInstallRoot
    ? mustPath(ctx.toolInstallRoot, "tool install root")
    : undefined;
  if (installRoot) assertPrivateDir("tool install root", installRoot, dataRoot, home);

  const git = ctx.git ? normalizeGit(ctx.git, writableRoot, dataRoot, home) : undefined;
  const identity = ctx.gitIdentity ? normalizeIdentity(ctx.gitIdentity) : undefined;

  const readExec: string[] = [];
  const readWrite: string[] = [];
  const seenExec = new Set<string>();
  const seenWrite = new Set<string>();
  const grantExec = (path: string) => addPath(readExec, seenExec, path);
  const grantWrite = (path: string) => addPath(readWrite, seenWrite, path);

  for (const path of systemPathsFor(platform, ctx.systemPaths)) {
    assertNoDataRoot("system path", path, dataRoot);
    grantExec(path);
  }

  const allowedPath: string[] = [];
  for (const path of ctx.pathEntries) {
    const normalized = mustPath(path, "PATH entry");
    // `$HOME` and a PATH entry that contains the data root are left out. They are not errors:
    // the rest of PATH still runs. An entry inside the data root, or that is an ancestor of
    // the home directory, is left out for the same reason.
    if (skipPathEntry(normalized, home, dataRoot)) continue;
    allowedPath.push(normalized);
    grantExec(normalized);
  }
  if (installRoot) grantExec(installRoot);
  let rustupHome: string | undefined;
  for (const path of toolchainPathsFor(home, ctx.toolchainPaths)) {
    assertNoDataRoot("toolchain path", path, dataRoot);
    if (posix.relative(home, path) === ".rustup") rustupHome = path;
    grantExec(path);
  }
  for (const path of readPaths) grantExec(path);
  if (git) grantExec(git.commonDir);

  grantWrite(writableRoot);
  grantWrite(tempDir);
  grantWrite(agentHome);
  grantWrite(cacheDir);
  const toolState = keyModeState(agentHome, tool);
  for (const path of Object.values(toolState)) grantWrite(path);
  for (const path of devicesFor(ctx.devices)) grantWrite(path);
  if (git) {
    grantWrite(posix.join(git.commonDir, "worktrees", git.worktreeName));
    grantWrite(posix.join(git.commonDir, "objects"));
    grantWrite(posix.join(git.commonDir, "refs", "heads", "boof-runner"));
    grantWrite(posix.join(git.commonDir, "logs"));
  }
  for (const path of writePaths) grantWrite(path);

  return {
    version: SANDBOX_POLICY_VERSION,
    readExec,
    readWrite,
    denyTcpPorts: denyPorts(ctx),
    env: policyEnv({
      agentHome,
      tempDir,
      cacheDir,
      rustupHome,
      path: allowedPath.join(":"),
      toolState,
      identity,
    }),
  };
}

function sandboxPlatform(platform: string): "linux" | "darwin" {
  if (platform === "win32") {
    throw new SandboxPolicyError(
      "windows_unsupported",
      "Windows has no sandbox backend; enforce cannot run agents",
    );
  }
  if (platform !== "linux" && platform !== "darwin") {
    throw new SandboxPolicyError(
      "unsupported_platform",
      `unsupported sandbox platform "${platform}"`,
    );
  }
  return platform;
}

function refuseLogin(platform: "linux" | "darwin", tool: string): never {
  const why =
    platform === "darwin"
      ? `login mode is refused for ${tool} on macOS: credentials are in the Keychain and opening it would open all of it`
      : `login mode is refused for ${tool}: the writable credential paths are not proven`;
  throw new SandboxPolicyError("login_mode_refused", `${why}; use an API key or the account pool`);
}

function keyModeState(agentHome: string, tool: string): Record<string, string> {
  const root = posix.join(agentHome, tool);
  return {
    CLAUDE_CONFIG_DIR: posix.join(root, "claude"),
    CODEX_HOME: posix.join(root, "codex"),
    XDG_CONFIG_HOME: posix.join(root, "xdg-config"),
    XDG_DATA_HOME: posix.join(root, "xdg-data"),
    XDG_STATE_HOME: posix.join(root, "xdg-state"),
  };
}

function policyEnv(facts: {
  agentHome: string;
  tempDir: string;
  cacheDir: string;
  rustupHome: string | undefined;
  path: string;
  toolState: Record<string, string>;
  identity: SandboxGitIdentity | undefined;
}): Record<string, string> {
  const cache = facts.cacheDir;
  const env: Record<string, string> = {
    HOME: facts.agentHome,
    TMPDIR: facts.tempDir,
    TMP: facts.tempDir,
    TEMP: facts.tempDir,
    XDG_CACHE_HOME: cache,
    npm_config_cache: posix.join(cache, "npm"),
    BUN_INSTALL_CACHE_DIR: posix.join(cache, "bun"),
    YARN_CACHE_FOLDER: posix.join(cache, "yarn"),
    npm_config_store_dir: posix.join(cache, "pnpm"),
    PIP_CACHE_DIR: posix.join(cache, "pip"),
    GOCACHE: posix.join(cache, "go-build"),
    GOMODCACHE: posix.join(cache, "go-mod"),
    CARGO_HOME: posix.join(cache, "cargo"),
  };
  if (facts.rustupHome) env.RUSTUP_HOME = facts.rustupHome;
  env.PATH = facts.path;
  Object.assign(env, facts.toolState);
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  if (facts.identity) {
    env.GIT_AUTHOR_NAME = facts.identity.authorName;
    env.GIT_AUTHOR_EMAIL = facts.identity.authorEmail;
    env.GIT_COMMITTER_NAME = facts.identity.committerName;
    env.GIT_COMMITTER_EMAIL = facts.identity.committerEmail;
  }
  env.UV_USE_IO_URING = "0";
  return env;
}

function denyPorts(ctx: SandboxPolicyContext): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (port: number, label: string) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxPolicyError(
        "invalid_port",
        `${label} port ${String(port)} is outside 1 to 65535`,
      );
    }
    if (seen.has(port)) return;
    seen.add(port);
    out.push(port);
  };
  for (const port of ctx.boofPorts) add(port, "boof");
  if (ctx.desktopPort !== undefined) add(ctx.desktopPort, "desktop");
  for (const port of ctx.denyTcpPorts) add(port, "denyTcpPorts");
  return out;
}

function systemPathsFor(platform: "linux" | "darwin", given: readonly string[]): string[] {
  const present = new Set<string>();
  for (const path of given) {
    const normalized = normalizeIfAbsolute(path);
    if (normalized && isSandboxSystemPath(platform, normalized)) present.add(normalized);
  }
  if (platform === "darwin") {
    return DARWIN_SYSTEM_ROOTS.filter((path) => present.has(path));
  }
  const libs = LINUX_LIB_PATHS.filter((path) => present.has(path));
  const head = LINUX_SYSTEM_ROOTS.slice(0, 3).filter((path) => present.has(path));
  const tail = LINUX_SYSTEM_ROOTS.slice(3).filter((path) => present.has(path));
  return [...head, ...libs, ...tail];
}

function toolchainPathsFor(home: string, given: readonly string[]): string[] {
  const present = new Set<string>();
  for (const path of given) {
    const normalized = mustPath(path, "toolchain path");
    const rel = posix.relative(home, normalized);
    if ((TOOLCHAIN_RELATIVE_PATHS as readonly string[]).includes(rel)) present.add(rel);
  }
  return TOOLCHAIN_RELATIVE_PATHS.filter((rel) => present.has(rel)).map((rel) =>
    posix.join(home, rel),
  );
}

function devicesFor(given: readonly string[]): string[] {
  const present = new Set<string>();
  for (const path of given) {
    const normalized = normalizeIfAbsolute(path);
    if (normalized && (SANDBOX_DEVICES as readonly string[]).includes(normalized))
      present.add(normalized);
  }
  return SANDBOX_DEVICES.filter((path) => present.has(path));
}

function normalizeGit(
  git: { commonDir: string; worktreeName: string },
  writableRoot: string,
  dataRoot: string,
  home: string,
): { commonDir: string; worktreeName: string } {
  const commonDir = mustPath(git.commonDir, "git common dir");
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(git.worktreeName)) {
    throw new SandboxPolicyError(
      "invalid_git",
      `git worktree name "${git.worktreeName}" must be a single path segment`,
    );
  }
  // Landlock cannot deny a child of an allowed directory. A common dir inside the writable
  // folder would make hooks and config writable no matter what the git rules say.
  if (commonDir === writableRoot || contains(writableRoot, commonDir)) {
    throw new SandboxPolicyError(
      "git_inside_writable",
      `git common dir "${commonDir}" is inside the writable folder, so hooks and config cannot be kept read-only`,
    );
  }
  assertNoDataRoot("git common dir", commonDir, dataRoot);
  assertNotAncestorOfHome("git common dir", commonDir, home);
  const worktreeDir = posix.join(commonDir, "worktrees", git.worktreeName);
  if (!contains(commonDir, worktreeDir)) {
    throw new SandboxPolicyError("invalid_git", `git worktree path escapes the common dir`);
  }
  return { commonDir, worktreeName: git.worktreeName };
}

function normalizeIdentity(identity: SandboxGitIdentity): SandboxGitIdentity {
  const out = {} as SandboxGitIdentity;
  for (const key of ["authorName", "authorEmail", "committerName", "committerEmail"] as const) {
    const value = identity[key];
    if (typeof value !== "string" || value.trim() === "" || /[\0\r\n]/.test(value)) {
      throw new SandboxPolicyError(
        "invalid_identity",
        `git identity ${key} is empty or has a newline`,
      );
    }
    out[key] = value;
  }
  return out;
}

function assertWritable(writable: string, dataRoot: string, home: string): void {
  const overlap = classify(writable, dataRoot);
  if (overlap === "equal" || overlap === "ancestor") {
    throw new SandboxPolicyError(
      "writable_contains_data_root",
      `writable folder "${writable}" contains the data root`,
    );
  }
  if (overlap === "inside") {
    throw new SandboxPolicyError(
      "writable_contains_data_root",
      `writable folder "${writable}" is inside the data root`,
    );
  }
  if (writable === home || contains(writable, home)) {
    throw new SandboxPolicyError(
      "writable_is_home",
      `writable folder "${writable}" is the user's home or an ancestor of it`,
    );
  }
}

function assertAllowedPath(path: string, dataRoot: string, home: string): void {
  const overlap = classify(path, dataRoot);
  if (overlap) {
    const why =
      overlap === "inside"
        ? `allowed path "${path}" is inside the data root`
        : `allowed path "${path}" is the data root or an ancestor of it`;
    throw new SandboxPolicyError("allowed_path_overlaps_data_root", why);
  }
  if (path === home || contains(path, home)) {
    throw new SandboxPolicyError(
      "allowed_path_is_home",
      `allowed path "${path}" is the user's home or an ancestor of it`,
    );
  }
}

function assertPrivateDir(label: string, path: string, dataRoot: string, home: string): void {
  assertNoDataRoot(label, path, dataRoot);
  if (path === home || contains(path, home)) {
    throw new SandboxPolicyError(
      "path_is_home",
      `${label} "${path}" is the user's home or an ancestor of it`,
    );
  }
}

function assertNotAncestorOfHome(label: string, path: string, home: string): void {
  if (path === home || contains(path, home)) {
    throw new SandboxPolicyError(
      "path_is_home",
      `${label} "${path}" is the user's home or an ancestor of it`,
    );
  }
}

function assertNoDataRoot(label: string, path: string, dataRoot: string): void {
  if (classify(path, dataRoot)) {
    throw new SandboxPolicyError(
      "path_overlaps_data_root",
      `${label} "${path}" overlaps the data root`,
    );
  }
}

/** A PATH entry that would expose the home directory or the data root is omitted, not granted. */
function skipPathEntry(path: string, home: string, dataRoot: string): boolean {
  if (path === home || contains(path, home)) return true;
  return classify(path, dataRoot) !== null;
}

type Overlap = "equal" | "ancestor" | "inside";

function classify(path: string, root: string): Overlap | null {
  if (path === root) return "equal";
  if (contains(path, root)) return "ancestor";
  if (contains(root, path)) return "inside";
  return null;
}

function contains(parent: string, child: string): boolean {
  const rel = posix.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
}

function addPath(list: string[], seen: Set<string>, path: string): void {
  if (seen.has(path)) return;
  seen.add(path);
  list.push(path);
}

function mustPath(path: string, label: string): string {
  const normalized = normalizeIfAbsolute(path);
  if (!normalized) {
    throw new SandboxPolicyError("invalid_path", `${label} "${path}" is not an absolute path`);
  }
  return normalized;
}

function normalizeIfAbsolute(path: string): string | null {
  if (typeof path !== "string" || path.includes("\0") || !posix.isAbsolute(path)) return null;
  return posix.resolve(path);
}

function toolSegment(tool: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,64}$/.test(tool)) {
    throw new SandboxPolicyError("invalid_tool", `tool id "${tool}" is not a single path segment`);
  }
  return tool;
}
