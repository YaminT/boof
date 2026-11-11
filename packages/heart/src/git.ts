import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execCommand } from "./process.js";

const LEFTOVERS_SUFFIX = "--leftovers";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Empty tree in a SHA-1 repository. A SHA-256 repository must not use this id: git rejects it
 * with `bad --attr-source`. Those repos hash an empty tree instead.
 */
export const SHA1_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Leading `-c` overrides for every git call the server makes in a repository an agent can write.
 * The agent can set `core.fsmonitor` or install hooks in the shared `.git`; without these the
 * server's next `git status` would run them with the server's environment. Command-line `-c`
 * overrides repository config.
 *
 * `--attr-source` is not listed here. Git 2.40 and newer receive it, aimed at an empty tree, so
 * in-tree `.gitattributes` do not apply. That does not cover `$GIT_COMMON_DIR/info/attributes`:
 * git still reads that file, and an agent can write it. It is checked after the driver list and
 * the command is refused when it assigns a `filter=` or `merge=` attribute. Git before 2.40
 * (Apple Git 2.39 on macOS) rejects `--attr-source`, so the option is omitted there; the
 * attributes check and the config blanking still apply.
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

/** `--attr-source` arrived in git 2.40. Earlier git exits 129 on the unknown option. */
export function gitVersionSupportsAttrSource(versionText: string): boolean {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionText);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 2) return true;
  if (major < 2) return false;
  return minor >= 40;
}

function isBlank(char: string): boolean {
  return char === " " || char === "\t";
}

/** End index after a C-style quoted token that starts at `start`, or null when it never closes. */
function endQuoted(line: string, start: number): number | null {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      if (i + 1 >= line.length) return null;
      i += 2;
      continue;
    }
    if (line[i] === '"') return i + 1;
    i += 1;
  }
  return null;
}

/** Pattern, then attributes, using git's rule that a leading `"` quotes only the pattern. */
function attributeTokens(line: string): string[] {
  let i = 0;
  while (i < line.length && isBlank(line[i]!)) i += 1;
  if (i >= line.length || line[i] === "#") return [];
  const tokens: string[] = [];
  const pushPlain = (from: number) => {
    let j = from;
    while (j < line.length && !isBlank(line[j]!)) j += 1;
    tokens.push(line.slice(from, j));
    i = j;
  };
  if (line[i] === '"') {
    const end = endQuoted(line, i);
    if (end === null) pushPlain(i);
    else {
      tokens.push(line.slice(i, end));
      i = end;
    }
  } else {
    pushPlain(i);
  }
  while (i < line.length) {
    while (i < line.length && isBlank(line[i]!)) i += 1;
    if (i >= line.length) break;
    pushPlain(i);
  }
  return tokens;
}

/**
 * True when gitattributes text assigns any `filter=` or `merge=` attribute. A comment, a
 * pattern that merely contains those letters, and a boolean `filter` or `merge` do not.
 */
export function attributesSelectDriver(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const tokens = attributeTokens(line);
    for (let n = 1; n < tokens.length; n += 1) {
      const token = tokens[n]!;
      if (token.startsWith("filter=") || token.startsWith("merge=")) return true;
    }
  }
  return false;
}

/**
 * Assignments that blank every `filter.*` key and every `merge.*.driver` in a
 * `git config --null --get-regexp` listing. `git -c name=value` splits on the first `=`,
 * so a driver named `x=y` (`filter.x=y.clean`, `merge.x=y.driver`) cannot be cleared that way.
 * `GIT_CONFIG_KEY_<n>` can hold those keys. An empty command disables the driver; `required`
 * is set false so git does not demand a command that was just cleared. A driver created after
 * this read can still run.
 */
export function driverOverridesFromConfig(stdout: string): Array<{ key: string; value: string }> {
  const byKey = new Map<string, string>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const key = record.split("\n", 1)[0] ?? "";
    if (key.startsWith("filter.")) byKey.set(key, key.endsWith(".required") ? "false" : "");
    else if (/^merge\..+\.driver$/.test(key)) byKey.set(key, "");
  }
  return [...byKey.keys()].sort().map((key) => ({ key, value: byKey.get(key) ?? "" }));
}

function isNeutralisedDriverKey(key: string): boolean {
  return key.startsWith("filter.") || /^merge\..+\.driver$/.test(key);
}

/**
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` for `overrides`, keeping
 * any other pairs already in `base`. Inherited filter and merge-driver pairs are dropped so
 * they cannot put a command back.
 */
function envWithDriverOverrides(
  base: NodeJS.ProcessEnv,
  overrides: readonly { key: string; value: string }[],
): NodeJS.ProcessEnv {
  const kept: Array<{ key: string; value: string }> = [];
  const count = Number(base.GIT_CONFIG_COUNT);
  if (Number.isInteger(count) && count > 0) {
    for (let i = 0; i < count; i++) {
      const key = base[`GIT_CONFIG_KEY_${i}`];
      const value = base[`GIT_CONFIG_VALUE_${i}`];
      if (typeof key !== "string" || typeof value !== "string" || isNeutralisedDriverKey(key)) {
        continue;
      }
      kept.push({ key, value });
    }
  }
  const pairs = [...kept, ...overrides];
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach((pair, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = pair.key;
    env[`GIT_CONFIG_VALUE_${index}`] = pair.value;
  });
  return env;
}

function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

/** Timeout for the config read that finds filter and merge drivers. */
const DRIVER_LIST_TIMEOUT_MS = 10_000;

/** Matches every filter key and every custom merge driver. POSIX ERE, as git config expects. */
const DRIVER_LIST_PATTERN = "^filter\\.|^merge\\..*\\.driver$";

/** A hardened git command was refused before it ran. */
export class GitCommandRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCommandRefusedError";
  }
}

/**
 * The driver list could not be read. Blanking `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
 * would leave drivers in the repository's `.git/config` active, so the git command is refused.
 */
export class GitDriversUnreadError extends GitCommandRefusedError {
  constructor(detail: string) {
    super(`refusing git command: could not list filter and merge drivers (${detail})`);
    this.name = "GitDriversUnreadError";
  }
}

/** `$GIT_COMMON_DIR/info/attributes` assigns a filter or merge driver, or could not be checked. */
export class GitInfoAttributesError extends GitCommandRefusedError {
  constructor(detail: string) {
    super(`refusing git command: ${detail}`);
    this.name = "GitInfoAttributesError";
  }
}

/**
 * Test override for the two facts `--attr-source` depends on. Production callers leave it unset.
 * `versionText` is raw `git --version` output. `objectFormat` selects the SHA-1 constant or a
 * per-repo `git hash-object -t tree` of an empty tree.
 */
export interface GitCapabilityProbe {
  versionText?: string;
  objectFormat?: "sha1" | "sha256";
}

/** One process uses one git binary. A probe does not write this. */
let cachedAttrSourceSupport: boolean | undefined;

/** Empty-tree id per common dir. SHA-256 ids differ from {@link SHA1_EMPTY_TREE}. */
const emptyTreeCache = new Map<string, string>();

function probeEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), LC_ALL: "C" };
}

async function attrSourceSupported(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  probe: GitCapabilityProbe | undefined,
): Promise<boolean> {
  if (probe?.versionText !== undefined) return gitVersionSupportsAttrSource(probe.versionText);
  if (cachedAttrSourceSupport !== undefined) return cachedAttrSourceSupport;
  const versionTimeout = Math.min(DRIVER_LIST_TIMEOUT_MS, timeoutMs);
  const res = await execCommand("git", ["--version"], {
    cwd,
    timeoutMs: versionTimeout,
    env,
  });
  if (res.timedOut) {
    throw new GitCommandRefusedError(
      `refusing git command: could not read git version (timed out after ${versionTimeout} ms)`,
    );
  }
  // A missing git binary should surface from the caller's command, not stick in the cache.
  if (res.code !== 0) return false;
  cachedAttrSourceSupport = gitVersionSupportsAttrSource(`${res.stdout}\n${res.stderr}`);
  return cachedAttrSourceSupport;
}

type CommonDir = { kind: "dir"; path: string } | { kind: "not-repo" };

/**
 * Common dir of `cwd`, or `not-repo` when this directory is not a repository. Other failures
 * are refused: the info/attributes check cannot be skipped for a repository we cannot name.
 */
async function resolveCommonDir(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<CommonDir> {
  const res = await execCommand("git", [...GIT_HARDENING_ARGS, "rev-parse", "--git-common-dir"], {
    cwd,
    timeoutMs,
    env: probeEnvironment(env),
  });
  if (res.timedOut) {
    throw new GitInfoAttributesError(
      `could not resolve the git common dir (timed out after ${timeoutMs} ms)`,
    );
  }
  const printed = res.stdout.trim();
  if (res.code !== 0 || !printed) {
    const detail = (res.stderr || res.stdout || `exit ${res.code ?? "unknown"}`).trim();
    if (/not a git repository/i.test(detail)) return { kind: "not-repo" };
    throw new GitInfoAttributesError(`could not resolve the git common dir (${detail})`);
  }
  const abs = resolve(cwd, printed);
  return { kind: "dir", path: await realpath(abs).catch(() => abs) };
}

async function readObjectFormat(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<"sha1" | "sha256" | null> {
  const res = await execCommand(
    "git",
    [...GIT_HARDENING_ARGS, "rev-parse", "--show-object-format"],
    { cwd, timeoutMs, env },
  );
  if (res.timedOut) {
    throw new GitCommandRefusedError(
      `refusing git command: could not read the object format (timed out after ${timeoutMs} ms)`,
    );
  }
  const format = res.stdout.trim();
  if (res.code === 0 && (format === "sha1" || format === "sha256")) return format;
  return null;
}

/** Empty tree id via `git hash-object -t tree` of empty input (the `/dev/null` form, on any OS). */
async function hashEmptyTree(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<string> {
  const res = await execCommand(
    "git",
    [...GIT_HARDENING_ARGS, "hash-object", "-t", "tree", "--no-filters", "--stdin"],
    { cwd, timeoutMs, env, input: "" },
  );
  if (res.timedOut) {
    throw new GitCommandRefusedError(
      `refusing git command: could not hash the empty tree (timed out after ${timeoutMs} ms)`,
    );
  }
  const oid = res.stdout.trim().toLowerCase();
  if (res.code !== 0 || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) {
    const detail = (res.stderr || res.stdout || `exit ${res.code ?? "unknown"}`).trim();
    throw new GitCommandRefusedError(
      `refusing git command: could not hash the empty tree (${detail})`,
    );
  }
  return oid;
}

async function emptyTreeFor(
  cwd: string,
  commonDir: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  probe: GitCapabilityProbe | undefined,
): Promise<string> {
  if (probe?.objectFormat === "sha1") return SHA1_EMPTY_TREE;
  if (probe?.objectFormat !== "sha256") {
    const cached = emptyTreeCache.get(commonDir);
    if (cached) return cached;
    if ((await readObjectFormat(cwd, env, timeoutMs)) === "sha1") {
      emptyTreeCache.set(commonDir, SHA1_EMPTY_TREE);
      return SHA1_EMPTY_TREE;
    }
  }
  const oid = await hashEmptyTree(cwd, env, timeoutMs);
  if (!probe?.objectFormat) emptyTreeCache.set(commonDir, oid);
  return oid;
}

/**
 * Refuse when the shared `info/attributes` names a filter or merge driver. Called after the
 * driver list, so a file written while that list was running is still seen.
 */
async function assertInfoAttributesClear(commonDir: string): Promise<void> {
  const path = join(commonDir, "info", "attributes");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitInfoAttributesError(`could not read ${path} (${detail})`);
  }
  if (attributesSelectDriver(text)) {
    throw new GitInfoAttributesError(`${path} sets a filter= or merge= attribute`);
  }
}

async function readDriverOverrides(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  hardening: readonly string[],
): Promise<Array<{ key: string; value: string }>> {
  const listTimeout = Math.min(DRIVER_LIST_TIMEOUT_MS, timeoutMs);
  let listed;
  try {
    listed = await execCommand(
      "git",
      [...hardening, "config", "--null", "--get-regexp", DRIVER_LIST_PATTERN],
      { cwd, timeoutMs: listTimeout, env },
    );
  } catch (error) {
    throw new GitDriversUnreadError(error instanceof Error ? error.message : String(error));
  }
  if (listed.timedOut) {
    throw new GitDriversUnreadError(`timed out after ${listTimeout} ms`);
  }
  if (listed.code !== 0 && listed.code !== 1) {
    const detail = (listed.stderr || listed.stdout || `exit ${listed.code ?? "unknown"}`).trim();
    throw new GitDriversUnreadError(detail);
  }
  return driverOverridesFromConfig(listed.stdout);
}

function hardeningArgs(attrSource: string | null): string[] {
  return attrSource === null
    ? [...GIT_HARDENING_ARGS]
    : [`--attr-source=${attrSource}`, ...GIT_HARDENING_ARGS];
}

/** Hardening args plus the environment that blanks filter and merge drivers, then `args`. */
export async function hardenedGitCommand(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = DRIVER_LIST_TIMEOUT_MS,
  probe?: GitCapabilityProbe,
): Promise<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> {
  const callerEnv = gitEnv(env);
  const common = await resolveCommonDir(cwd, callerEnv, timeoutMs);
  const attrSource =
    common.kind === "dir" && (await attrSourceSupported(cwd, callerEnv, timeoutMs, probe))
      ? await emptyTreeFor(cwd, common.path, callerEnv, timeoutMs, probe)
      : null;
  const hardening = hardeningArgs(attrSource);
  const overrides = await readDriverOverrides(cwd, callerEnv, timeoutMs, hardening);
  // Last step before the caller runs git: a filter planted during the driver list is visible.
  if (common.kind === "dir") await assertInfoAttributesClear(common.path);
  return {
    args: [...hardening, ...args],
    env:
      overrides.length === 0
        ? callerEnv
        : envWithDriverOverrides(callerEnv ?? process.env, overrides),
  };
}

/** Timeout for ordinary git calls. */
export const GIT_TIMEOUT_MS = 30_000;
export async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = GIT_TIMEOUT_MS,
  probe?: GitCapabilityProbe,
): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  const prepared = await hardenedGitCommand(cwd, args, env, timeoutMs, probe);
  const res = await execCommand("git", prepared.args, {
    cwd,
    timeoutMs,
    env: prepared.env,
  });
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim(), timedOut: res.timedOut };
}

/** True if `dir` is inside a git working tree (worktree-isolation spec). */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.out === "true";
}

/**
 * Realpath of the git common dir of `dir` (`rev-parse --git-common-dir`): the same for a
 * repository's main checkout, its subdirectories and its linked worktrees; null when git fails.
 */
export async function repoCommonDir(dir: string): Promise<string | null> {
  // No `--path-format=absolute` (git < 2.31 echoes it): the printed path may be relative to `dir`.
  const res = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (res.code !== 0 || !res.out) return null;
  const abs = resolve(dir, res.out);
  return realpath(abs).catch(() => abs);
}

export interface InitGitRepoOptions {
  /** Per git call; a hung git must not hold the project-create lock. Defaults to GIT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra environment for the git calls (tests isolate HOME / GIT_CONFIG_GLOBAL, or fake git). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Make `dir` a git repository with at least one commit, so worktree isolation works: `git init`
 * when it is not a repository, then an empty "Initial commit" when HEAD is unborn. The commit
 * falls back to its own identity where git has none, and never signs (per invocation; the user's git config is not touched).
 * Throws when a git call fails or times out (the process is killed).
 */
export async function initGitRepo(dir: string, opts: InitGitRepoOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const run = async (args: string[]) => {
    const res = await git(dir, args, { GIT_TERMINAL_PROMPT: "0", ...opts.env }, timeoutMs);
    if (res.timedOut) {
      throw new Error(`git ${args[0]} timed out after ${timeoutMs} ms in ${dir}`);
    }
    return res;
  };
  // `dir` itself must be a repository: inside a parent's work tree, git would use the parent.
  if (!(await pathExists(join(dir, ".git")))) {
    const init = await run(["init", "-q"]);
    if (init.code !== 0) throw new Error(`git init failed in ${dir}: ${init.err}`);
  }
  if ((await run(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) return;
  // The boof identity is only a fallback for what the owner's git config lacks.
  const identity: string[] = [];
  if (!(await run(["config", "user.name"])).out) identity.push("-c", "user.name=Boof Runner");
  if (!(await run(["config", "user.email"])).out) {
    identity.push("-c", "user.email=boof-runner@localhost");
  }
  const commit = await run([
    ...identity,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "Initial commit",
  ]);
  if (commit.code !== 0) throw new Error(`git init failed in ${dir}: ${commit.err}`);
}

/** Branch checked out in `dir` (git symbolic-ref); null when detached, not a repo or git fails. */
export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const res = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return res.code === 0 && res.out ? res.out : null;
  } catch {
    return null;
  }
}

/**
 * True when `refs/heads/<branch>` exists in the repository of `workingDir`. Not `plan-base`'s
 * `branchExists` (a different export: it takes a repo root, trims, and returns false on a failed
 * git call), which is why this one has its own name.
 */
export async function localBranchExists(workingDir: string, branch: string): Promise<boolean> {
  const res = await git(workingDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

export async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Branch checked out in the registered worktree at `path`, or null if none. */
export async function registeredWorktreeBranch(
  workingDir: string,
  path: string,
): Promise<string | null> {
  const list = await git(workingDir, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return null;
  const target = await canonical(path);
  for (const entry of list.out.split(/\n\s*\n/)) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    for (const line of entry.split("\n")) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/"))
        branch = line.slice("branch refs/heads/".length);
    }
    if (wtPath && branch && (await canonical(wtPath)) === target) return branch;
  }
  return null;
}

/** Side branch holding a task's uncommitted leftovers. */
export function leftoversBranch(wt: { branch: string }): string {
  return `${wt.branch}${LEFTOVERS_SUFFIX}`;
}

/** HEAD commit sha of a task branch, or "(unknown)". */
export async function branchHead(workingDir: string, branch: string): Promise<string> {
  const res = await git(workingDir, ["rev-parse", `refs/heads/${branch}`]);
  return res.code === 0 && res.out ? res.out : "(unknown)";
}

/**
 * Prune stale per-task worktrees on startup so crashed runs don't accumulate
 * (worktree-isolation spec). Only git bookkeeping for missing directories is
 * pruned; worktree directories and task branches are never removed. Rejects when git exits
 * non-zero or times out, so callers can log it.
 */
export async function pruneStaleWorktrees(workingDir: string): Promise<void> {
  if (!(await isGitRepo(workingDir))) return;
  const res = await git(workingDir, ["worktree", "prune"]);
  if (res.timedOut) throw new Error(`git worktree prune timed out in ${workingDir}`);
  if (res.code !== 0) {
    throw new Error(
      `git worktree prune failed in ${workingDir} (exit ${res.code}): ${res.err || res.out}`,
    );
  }
}
