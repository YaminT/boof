import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execCommand } from "./exec.js";

const BRANCH_PREFIX = "boof-runner/";
const LEFTOVERS_SUFFIX = "--leftovers";

function metaPath(root: string, taskId: string): string {
  return join(root, ".meta", `${taskId}.json`);
}

/** What happens to a done task's branch and directory (settings.worktree.onDone). */
export type DonePolicy = "keep-branch" | "keep" | "delete";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface Worktree {
  /** Absolute path to the per-task worktree checkout. */
  path: string;
  /** Branch created for this task. */
  branch: string;
  /** Base revision the worktree was branched from (for diffing). */
  base: string;
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  const res = await execCommand("git", args, {
    cwd,
    timeoutMs: 30000,
    env: env ? { ...process.env, ...env } : undefined,
  });
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim() };
}

/** True if `dir` is inside a git working tree (worktree-isolation spec). */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.out === "true";
}

export class UnknownBaseRefError extends Error {
  constructor(
    public readonly base: string,
    public readonly dir: string,
  ) {
    super(`unknown base ref '${base}': not a branch or commit in ${dir}`);
    this.name = "UnknownBaseRefError";
  }
}

export class NotAGitRepoError extends Error {
  constructor(public readonly dir: string) {
    super(
      `workingDirectory is not a git repository: ${dir}. ` +
        `Worktree-isolated runs require a git repo; refusing to run agents.`,
    );
    this.name = "NotAGitRepoError";
  }
}

async function branchExists(workingDir: string, branch: string): Promise<boolean> {
  const res = await git(workingDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0;
}

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Branch checked out in the registered worktree at `path`, or null if none. */
async function registeredWorktreeBranch(workingDir: string, path: string): Promise<string | null> {
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

export interface WorktreeOptions {
  /** Directory holding task worktrees (`<root>/<taskId>`, sidecar in `<root>/.meta`). */
  root: string;
  /** Branch or commit a NEW task branch starts from; default the working directory's HEAD. */
  base?: string;
}

export interface WorktreeResult {
  worktree: Worktree;
  /** True when the directory or the task branch already existed. */
  reused: boolean;
  /** True when `base` was given but ignored because the branch or directory already existed. */
  baseIgnored: boolean;
}

/**
 * Create a per-task git worktree for `workingDir` under `opts.root`. Throws
 * NotAGitRepoError if the directory is not a git repo and UnknownBaseRefError
 * if `opts.base` does not resolve (before anything is created). Never deletes
 * anything: an existing task branch is reused (and `base` ignored), and an
 * existing directory that is not a registered worktree of that branch fails the
 * call untouched.
 */
export async function createWorktree(
  workingDir: string,
  taskId: string,
  opts: WorktreeOptions,
): Promise<WorktreeResult> {
  if (!(await isGitRepo(workingDir))) throw new NotAGitRepoError(workingDir);

  const root = resolve(opts.root);
  const branch = `${BRANCH_PREFIX}${taskId}`;
  const path = join(root, taskId);
  const meta = await readMeta(root, taskId);
  const hasPath = await pathExists(path);
  const hasBranch = await branchExists(workingDir, branch);
  const baseIgnored = !!opts.base && (hasPath || hasBranch);

  if (hasPath) {
    if ((await registeredWorktreeBranch(workingDir, path)) !== branch) {
      throw new Error(
        `Worktree path already exists and is not a registered worktree of ${branch}: ${path}. ` +
          `Refusing to touch it; move or remove it manually.`,
      );
    }
    const wt = meta ?? { path, branch, base: await mergeBase(workingDir, branch) };
    await writeMeta(root, taskId, wt);
    return { worktree: wt, reused: true, baseIgnored };
  }

  // Resolve the base before anything is created, so an unknown ref leaves no trace.
  let newBase: string | null = null;
  if (!hasBranch) {
    if (opts.base) {
      const res = opts.base.startsWith("-")
        ? { code: 1, out: "" }
        : await git(workingDir, ["rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`]);
      if (res.code !== 0 || !res.out) throw new UnknownBaseRefError(opts.base, workingDir);
      newBase = res.out;
    } else {
      const headRes = await git(workingDir, ["rev-parse", "HEAD"]);
      newBase = headRes.code === 0 ? headRes.out : "HEAD";
    }
  }

  // Drops only registrations whose directory is gone; lets `worktree add` succeed on retry.
  await git(workingDir, ["worktree", "prune"]);
  await mkdir(root, { recursive: true });

  let base: string;
  let add: { code: number | null; out: string; err: string };
  if (newBase === null) {
    base = meta?.base ?? (await mergeBase(workingDir, branch));
    add = await git(workingDir, ["worktree", "add", path, branch]);
  } else {
    base = newBase;
    add = await git(workingDir, ["worktree", "add", "-b", branch, path, base]);
  }
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.err || add.out}`);
  }
  const wt = { path, branch, base };
  await writeMeta(root, taskId, wt);
  return { worktree: wt, reused: hasBranch, baseIgnored };
}

async function mergeBase(workingDir: string, branch: string): Promise<string> {
  const res = await git(workingDir, ["merge-base", "HEAD", branch]);
  if (res.code !== 0 || !res.out) {
    throw new Error(`git merge-base HEAD ${branch} failed: ${res.err || res.out}`);
  }
  return res.out;
}

async function writeMeta(root: string, taskId: string, wt: Worktree): Promise<void> {
  const mp = metaPath(root, taskId);
  await mkdir(join(mp, ".."), { recursive: true });
  await writeFile(mp, JSON.stringify(wt), "utf8");
}

async function readMeta(root: string, taskId: string): Promise<Worktree | null> {
  try {
    return JSON.parse(await readFile(metaPath(root, taskId), "utf8")) as Worktree;
  } catch {
    return null;
  }
}

/**
 * Reuse the task's registered worktree if present, otherwise create one (reusing
 * an existing task branch). Reuse makes multi-run iterations cumulative: each
 * run sees the prior run's work in the same checkout (runs feature).
 */
export async function ensureWorktree(
  workingDir: string,
  taskId: string,
  opts: WorktreeOptions,
): Promise<WorktreeResult> {
  if (!(await isGitRepo(workingDir))) throw new NotAGitRepoError(workingDir);
  const result = await createWorktree(workingDir, taskId, opts);
  await excludeRootFromGit(workingDir, opts.root);
  return result;
}

/**
 * Keep a worktree root that lives inside the repository out of `git status` by
 * listing it in the repo's `info/exclude` (never the tracked .gitignore).
 * Idempotent and best-effort: failures are logged, never thrown.
 */
export async function excludeRootFromGit(workingDir: string, root: string): Promise<void> {
  try {
    const top = await git(workingDir, ["rev-parse", "--show-toplevel"]);
    const gp = await git(workingDir, ["rev-parse", "--git-path", "info/exclude"]);
    if (top.code !== 0 || gp.code !== 0 || !top.out || !gp.out) return;
    const rel = relative(await canonical(top.out), await canonical(resolve(root)));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    const entry = `/${rel.split(sep).join("/")}/`;
    const file = resolve(workingDir, gp.out);
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch {
      /* missing: created below */
    }
    const norm = (l: string) => l.trim().replace(/^\//, "").replace(/\/$/, "");
    if (
      existing.split(/\r?\n/).some((l) => l.trim() && !l.startsWith("#") && norm(l) === norm(entry))
    )
      return;
    await mkdir(dirname(file), { recursive: true });
    const sepNl = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(file, `${existing}${sepNl}${entry}\n`, "utf8");
  } catch (err) {
    console.warn(`[boof-runner] could not exclude worktree root from git: ${String(err)}`);
  }
}

export interface InlineDiff {
  /** Text to inline into a prompt (full diff, or a capped summary). */
  text: string;
  /** True when the full diff exceeded the inline limit. */
  capped: boolean;
  /** Byte size of the full diff. */
  bytes: number;
  /** Resolved base sha the agent can diff against. */
  baseSha: string;
}

/**
 * Diff the worktree against its base revision (reviewer/observer input). A diff
 * larger than `maxInlineBytes` is replaced by the --stat summary, the untracked
 * file list and a note telling the agent how to read the full diff itself.
 */
export async function diffAgainstBase(wt: Worktree, maxInlineBytes = 120000): Promise<InlineDiff> {
  // Include both committed and uncommitted changes relative to base.
  const stat = await git(wt.path, ["diff", `${wt.base}`, "--stat"]);
  const full = await git(wt.path, ["--no-pager", "diff", wt.base]);
  const untracked = await git(wt.path, ["ls-files", "--others", "--exclude-standard"]);
  const rev = await git(wt.path, ["rev-parse", wt.base]);
  const baseSha = rev.code === 0 && rev.out ? rev.out : wt.base;
  const bytes = Buffer.byteLength(full.out);
  const untrackedBlock = untracked.out ? "## Untracked files\n" + untracked.out : "";
  if (bytes <= maxInlineBytes) {
    const text = ["## Summary\n" + stat.out, "## Diff\n" + full.out, untrackedBlock]
      .filter(Boolean)
      .join("\n\n");
    return { text, capped: false, bytes, baseSha };
  }
  const note =
    `## Note\nThe full diff (${bytes} bytes) exceeds the inline limit (${maxInlineBytes} bytes). ` +
    `Read it yourself with \`git diff ${baseSha}\`; per file, \`git diff ${baseSha} -- <path>\`.`;
  const text = ["## Summary\n" + stat.out, untrackedBlock, note].filter(Boolean).join("\n\n");
  return { text, capped: true, bytes, baseSha };
}

/** Side branch holding a task's uncommitted leftovers. */
export function leftoversBranch(wt: Worktree): string {
  return `${wt.branch}${LEFTOVERS_SUFFIX}`;
}

export interface LeftoversResult {
  branch: string;
  sha: string;
  /**
   * Paths whose content the snapshot does not hold: nested git repositories (skipped when
   * they have no commit, stored only as a gitlink otherwise). Removing the directory loses them.
   */
  unsaved: string[];
}

/**
 * Snapshot the worktree's uncommitted changes (including untracked files) onto
 * the side branch `<branch>--leftovers`, parented on the task branch head (and
 * on an earlier leftovers head, so it is never orphaned). Uses a temporary index
 * and `commit-tree`, so the task branch, the worktree's index and its files are
 * untouched. Returns null when the tree is clean; throws on git failure.
 */
export async function commitLeftovers(
  workingDir: string,
  wt: Worktree,
  title: string,
): Promise<LeftoversResult | null> {
  const status = await git(wt.path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`git status failed: ${status.err || status.out}`);
  if (!status.out) return null;

  const branch = leftoversBranch(wt);
  const tmp = await mkdtemp(join(tmpdir(), "boof-leftovers-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const run = async (args: string[]): Promise<string> => {
      const res = await git(wt.path, args, env);
      if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.err || res.out}`);
      return res.out;
    };
    const head = await run(["rev-parse", "HEAD"]);
    await run(["read-tree", "HEAD"]);
    // A nested git repository without a commit makes `git add` fail; leave those out.
    const skipped: string[] = [];
    for (;;) {
      const add = await git(
        wt.path,
        ["add", "-A", "--", ".", ...skipped.map((p) => `:(exclude)${p}`)],
        env,
      );
      if (add.code === 0) break;
      const fresh = [...add.err.matchAll(/'([^']+?)\/?' does not have a commit checked out/g)]
        .map((m) => m[1]!)
        .filter((p) => !skipped.includes(p));
      if (fresh.length === 0) throw new Error(`git add failed: ${add.err || add.out}`);
      skipped.push(...fresh);
    }
    const tree = await run(["write-tree"]);
    // Nested repositories with commits become gitlinks; their objects are not in this repo.
    const gitlinks = (await run(["diff-index", "--cached", "--raw", "HEAD"]))
      .split("\n")
      .filter((l) => /^:\d+ 160000 /.test(l))
      .map((l) => l.split("\t")[1]!)
      .filter(Boolean);
    const unsaved = [...skipped, ...gitlinks];

    const parents = ["-p", head];
    const prior = await git(workingDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (prior.code === 0 && prior.out) parents.push("-p", prior.out);

    // Fresh machines and CI may have no committer identity configured.
    const ident =
      (await git(wt.path, ["var", "GIT_COMMITTER_IDENT"])).code === 0 &&
      (await git(wt.path, ["var", "GIT_AUTHOR_IDENT"])).code === 0;
    const identArgs = ident
      ? []
      : ["-c", "user.name=boof-runner", "-c", "user.email=boof-runner@localhost"];
    const sha = await run([
      ...identArgs,
      "commit-tree",
      tree,
      ...parents,
      "-m",
      `boof-runner leftovers: ${title}`,
    ]);
    await run(["update-ref", `refs/heads/${branch}`, sha]);
    return { branch, sha, unsaved };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Remove the worktree directory (leftovers included) and delete the task branches. */
async function deleteWork(workingDir: string, wt: Worktree, why: string): Promise<string[]> {
  const lines: string[] = [];
  const remove = await git(workingDir, ["worktree", "remove", "--force", wt.path]);
  if (remove.code !== 0 && (await pathExists(wt.path))) {
    return [`Kept worktree ${wt.path}: git worktree remove failed: ${remove.err || remove.out}`];
  }
  const branches = [wt.branch];
  if (await branchExists(workingDir, leftoversBranch(wt))) branches.push(leftoversBranch(wt));
  for (const b of branches) {
    const del = await git(workingDir, ["branch", "-D", b]);
    if (del.code !== 0) lines.push(`Could not delete branch ${b}: ${del.err || del.out}`);
  }
  lines.push(`WARNING: DELETED task work: worktree ${wt.path} and branch ${wt.branch} (${why})`);
  return lines;
}

/**
 * Finish a task's worktree on final done, per `policy` (settings.worktree.onDone):
 * - keep-branch: leftovers go to the `--leftovers` side branch, then the
 *   directory is removed; the task branch is untouched and kept.
 * - keep: leftovers go to the side branch; the directory is left in place.
 * - delete: directory and branch are removed (opt-in; logged loudly).
 * Never commits onto the task branch. Never throws; returns log lines. On any
 * failure the directory is kept.
 */
export async function finalizeWorktree(
  workingDir: string,
  wt: Worktree,
  title: string,
  policy: DonePolicy = "keep-branch",
): Promise<string[]> {
  if (policy === "delete") return deleteWork(workingDir, wt, "onDone=delete");

  // A detached or switched HEAD would leave commits unreferenced once the directory is removed.
  const head = await git(wt.path, ["symbolic-ref", "--quiet", "HEAD"]);
  if (head.code !== 0 || head.out !== `refs/heads/${wt.branch}`) {
    return [`Kept worktree ${wt.path}: HEAD is not on ${wt.branch} (${head.out || "detached"})`];
  }
  const lines: string[] = [];
  try {
    const left = await commitLeftovers(workingDir, wt, title);
    if (left) lines.push(`Leftovers committed to ${left.branch} at ${left.sha}`);
    if (left && left.unsaved.length > 0) {
      lines.push(
        `Kept worktree ${wt.path}: nested git repositories are not saved on ${left.branch} ` +
          `(${left.unsaved.join(", ")}); copy or commit them, then remove the directory`,
      );
      return lines;
    }
  } catch (err) {
    return [
      `Kept worktree ${wt.path}: saving leftovers failed: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
  if (policy === "keep") {
    lines.push(`Kept worktree directory ${wt.path} (branch ${wt.branch}, onDone=keep)`);
    return lines;
  }
  // --force: leftovers were just saved on the side branch (or the tree was clean).
  const remove = await git(workingDir, ["worktree", "remove", "--force", wt.path]);
  if (remove.code !== 0) {
    lines.push(`Kept worktree ${wt.path}: git worktree remove failed: ${remove.err || remove.out}`);
    return lines;
  }
  lines.push(`Removed worktree directory ${wt.path} (branch ${wt.branch} kept)`);
  return lines;
}

/** Delete a failed task's directory and branch (settings.worktree.onFailure=delete). Never throws. */
export async function discardWorktree(workingDir: string, wt: Worktree): Promise<string[]> {
  return deleteWork(workingDir, wt, "onFailure=delete");
}

/** HEAD commit sha of a task branch, or "(unknown)". */
export async function branchHead(workingDir: string, branch: string): Promise<string> {
  const res = await git(workingDir, ["rev-parse", `refs/heads/${branch}`]);
  return res.code === 0 && res.out ? res.out : "(unknown)";
}

/**
 * Prune stale per-task worktrees on startup so crashed runs don't accumulate
 * (worktree-isolation spec). Only git bookkeeping for missing directories is
 * pruned; worktree directories and task branches are never removed.
 */
export async function pruneStaleWorktrees(workingDir: string): Promise<void> {
  if (!(await isGitRepo(workingDir))) return;
  await git(workingDir, ["worktree", "prune"]);
}
