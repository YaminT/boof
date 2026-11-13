import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  localBranchExists,
  git,
  isGitRepo,
  leftoversBranch,
  pathExists,
  registeredWorktreeBranch,
  repoCommonDir,
  canonical,
  MAX_UNTRACKED,
} from "@boof/heart";

const BRANCH_PREFIX = "boof-runner/";

function metaPath(root: string, taskId: string): string {
  return join(root, ".meta", `${taskId}.json`);
}

/** What happens to a done task's branch and directory (settings.worktree.onDone). */
export type DonePolicy = "keep-branch" | "keep" | "delete";

export interface Worktree {
  /** Absolute path to the per-task worktree checkout. */
  path: string;
  /** Branch created for this task. */
  branch: string;
  /** Base revision the worktree was branched from (for diffing). */
  base: string;
  /** Trusted runner record used to check mutable .git metadata before every server git call. */
  commonDir?: string;
  worktreeName?: string;
  /**
   * Sandbox-enforce hardening (refuse extensions.worktreeConfig, config.worktree, gitlinks and
   * .gitmodules). Absent means on; sandbox-off runs record `false`, as 0.4.1 behaved.
   */
  strict?: boolean;
}

/** Timeout for checkout-sized git calls (worktree add/remove, add -A): slow on a big repository. */
export const CHECKOUT_TIMEOUT_MS = 15 * 60_000;

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

export interface WorktreeOptions {
  /** Directory holding task worktrees (`<root>/<taskId>`, sidecar in `<root>/.meta`). */
  root: string;
  /** Branch or commit a NEW task branch starts from; default the working directory's HEAD. */
  base?: string;
  /** Timeout for `git worktree add`; default CHECKOUT_TIMEOUT_MS. */
  checkoutTimeoutMs?: number;
  /** Apply the enforce-mode git hardening to this worktree; default true. Sandbox-off runs pass false. */
  strict?: boolean;
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
  const hasBranch = await localBranchExists(workingDir, branch);
  const baseIgnored = !!opts.base && (hasPath || hasBranch);
  const commonDir = await repoCommonDir(workingDir);
  if (!commonDir) throw new Error(`git common dir is unavailable for ${workingDir}`);
  const trustedGit = {
    commonDir: await realpath(commonDir),
    worktreeName: basename(path),
    strict: opts.strict !== false,
  };

  if (hasPath) {
    if ((await registeredWorktreeBranch(workingDir, path)) !== branch) {
      throw new Error(
        `Worktree path already exists and is not a registered worktree of ${branch}: ${path}. ` +
          `Refusing to touch it; move or remove it manually.`,
      );
    }
    const wt = {
      ...(meta ?? { path, branch, base: await mergeBase(workingDir, branch) }),
      ...trustedGit,
    };
    await removeTaskBranchReflog(trustedGit.commonDir, branch);
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
  const addTimeout = opts.checkoutTimeoutMs ?? CHECKOUT_TIMEOUT_MS;
  let add: Awaited<ReturnType<typeof git>>;
  if (newBase === null) {
    base = meta?.base ?? (await mergeBase(workingDir, branch));
    add = await git(workingDir, ["worktree", "add", path, branch], undefined, addTimeout);
  } else {
    base = newBase;
    add = await git(
      workingDir,
      ["worktree", "add", "-b", branch, path, base],
      undefined,
      addTimeout,
    );
  }
  if (add.code !== 0 || add.timedOut) {
    await undoFailedAdd(workingDir, path, branch, newBase !== null);
    throw new Error(
      add.timedOut
        ? `git worktree add timed out after ${addTimeout / 1000}s (the half-made worktree was removed)`
        : `git worktree add failed: ${add.err || add.out}`,
    );
  }
  const wt: Worktree = { path, branch, base, ...trustedGit };
  await removeTaskBranchReflog(trustedGit.commonDir, branch);
  await writeMeta(root, taskId, wt);
  return { worktree: wt, reused: hasBranch, baseIgnored };
}

/** Remove what a failed or killed `worktree add` left; the branch only when this add created it. */
async function undoFailedAdd(
  workingDir: string,
  path: string,
  branch: string,
  deleteBranch: boolean,
): Promise<void> {
  await git(workingDir, ["worktree", "remove", "--force", path], undefined, CHECKOUT_TIMEOUT_MS);
  await git(workingDir, ["worktree", "prune"]);
  await rm(path, { recursive: true, force: true });
  if (deleteBranch) await git(workingDir, ["branch", "-D", branch]);
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

/** Read and verify the runner-owned sidecar record for a live task worktree. */
export async function loadWorktreeRecord(
  root: string,
  taskId: string,
  workingDir?: string,
): Promise<Worktree | null> {
  let wt = await readMeta(root, taskId);
  if (!wt) return null;
  if ((!wt.commonDir || !wt.worktreeName) && workingDir) {
    // A record written by 0.4.1 has no trusted git fields. Derive them when git itself lists
    // this directory as the registered worktree of the task branch, then store them.
    const path = join(resolve(root), taskId);
    const branch = `${BRANCH_PREFIX}${taskId}`;
    const common = await repoCommonDir(workingDir);
    if (common && (await registeredWorktreeBranch(workingDir, path)) === branch) {
      wt = {
        ...wt,
        path,
        branch,
        commonDir: await realpath(common),
        worktreeName: basename(path),
        strict: false,
      };
      await writeMeta(root, taskId, wt);
    }
  }
  await verifyWorktreeRecord(wt);
  return wt;
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
  const stat = await checkedWorktreeGit(wt, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    `${wt.base}`,
    "--stat",
  ]);
  const full = await checkedWorktreeGit(wt, [
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    wt.base,
  ]);
  await verifyWorktreeRecord(wt);
  const names = await worktreeUntrackedFiles(wt);
  const rev = await checkedWorktreeGit(wt, ["rev-parse", wt.base]);
  const baseSha = rev.code === 0 && rev.out ? rev.out : wt.base;
  const patches: string[] = [];
  for (const p of names) {
    await verifyWorktreeRecord(wt);
    patches.push((await worktreeUntrackedPatch(wt, p)).trimEnd());
  }
  const untrackedText = patches.filter(Boolean).join("\n");
  const bytes = Buffer.byteLength(full.out) + Buffer.byteLength(untrackedText);
  const untrackedBlock = names.length ? "## Untracked files\n" + names.join("\n") : "";
  if (bytes <= maxInlineBytes) {
    const diff = [full.out, untrackedText].filter(Boolean).join("\n");
    const text = ["## Summary\n" + stat.out, "## Diff\n" + diff, untrackedBlock]
      .filter(Boolean)
      .join("\n\n");
    return { text, capped: false, bytes, baseSha };
  }
  const note =
    `## Note\nThe full diff (${bytes} bytes) exceeds the inline limit (${maxInlineBytes} bytes). ` +
    `Read it yourself with \`git diff ${baseSha}\`; per file, \`git diff ${baseSha} -- <path>\`; ` +
    "untracked files: `git diff --no-index -- /dev/null <path>`.";
  const text = ["## Summary\n" + stat.out, untrackedBlock, note].filter(Boolean).join("\n\n");
  return { text, capped: true, bytes, baseSha };
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
  opts: { onTaskBranch?: boolean } = {},
): Promise<LeftoversResult | null> {
  // Inspect before status because status intentionally ignores submodule contents.
  const staged = await checkedWorktreeGit(wt, ["ls-files", "--stage", "-z"]);
  if (staged.code !== 0) throw new Error(`git ls-files failed: ${staged.err || staged.out}`);
  const baseTree = await checkedWorktreeGit(wt, ["ls-tree", "-r", "-z", wt.base]);
  if (baseTree.code !== 0) throw new Error(`git ls-tree failed: ${baseTree.err || baseTree.out}`);
  const baseLinks = new Map(
    gitlinksFromTree(baseTree.out.split("\0").filter((entry) => /^160000 commit /.test(entry))),
  );
  const stagedGitlinks = gitlinksFromIndex(staged.out.split("\0")).filter(
    ([path, oid]) => baseLinks.get(path) !== oid,
  );
  if (strict(wt) && stagedGitlinks.length > 0) {
    throw new Error(
      `refusing to snapshot gitlink entries: ${stagedGitlinks.map(([path]) => path).join(", ")}`,
    );
  }
  const headTree = await checkedWorktreeGit(wt, ["ls-tree", "-r", "-z", "HEAD"]);
  if (headTree.code !== 0) throw new Error(`git ls-tree failed: ${headTree.err || headTree.out}`);
  const headGitlinks = gitlinksFromTree(
    headTree.out.split("\0").filter((entry) => /^160000 commit /.test(entry)),
  ).filter(([path, oid]) => baseLinks.get(path) !== oid);
  if (strict(wt) && headGitlinks.length > 0) {
    throw new Error("refusing to snapshot gitlink entries present in HEAD");
  }
  // `git add` can read a .gitmodules override while walking nested gitlinks. Refuse any
  // worktree/index/HEAD .gitmodules before status/add, including untracked agent-written files.
  const modulesOnDisk = await lstat(join(wt.path, ".gitmodules")).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    },
  );
  const modulesInIndex = await checkedWorktreeGit(wt, ["ls-files", "--stage", "--", ".gitmodules"]);
  const modulesInHead = await checkedWorktreeGit(wt, [
    "ls-tree",
    "-z",
    "HEAD",
    "--",
    ".gitmodules",
  ]);
  if (modulesInIndex.code !== 0 || modulesInHead.code !== 0) {
    throw new Error("could not verify task worktree .gitmodules state");
  }
  const modulesInBase = await checkedWorktreeGit(wt, [
    "ls-tree",
    "-z",
    wt.base,
    "--",
    ".gitmodules",
  ]);
  if (modulesInBase.code !== 0)
    throw new Error(`git ls-tree failed: ${modulesInBase.err || modulesInBase.out}`);
  if (
    strict(wt) &&
    (modulesOnDisk || modulesInIndex.out || modulesInHead.out) &&
    !modulesInBase.out
  ) {
    throw new Error("refusing to snapshot an agent-controlled .gitmodules file");
  }
  const status = await checkedWorktreeGit(wt, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`git status failed: ${status.err || status.out}`);
  if (!status.out) return null;

  const onTaskBranch = opts.onTaskBranch === true;
  const branch = onTaskBranch ? wt.branch : leftoversBranch(wt);
  const tmp = await mkdtemp(join(tmpdir(), "boof-leftovers-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const run = async (args: string[], timeoutMs?: number): Promise<string> => {
      const res = await checkedWorktreeGit(wt, args, env, timeoutMs);
      if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.err || res.out}`);
      return res.out;
    };
    const head = await run(["rev-parse", "HEAD"]);
    await run(["read-tree", "HEAD"]);
    const tempIndex = await run(["ls-files", "--stage", "-z"]);
    const restoredGitlinks = gitlinksFromIndex(tempIndex.split("\0")).filter(
      ([path, oid]) => baseLinks.get(path) !== oid,
    );
    if (restoredGitlinks.length > 0) {
      throw new Error(
        `refusing to snapshot gitlink entries: ${restoredGitlinks.map(([path]) => path).join(", ")}`,
      );
    }
    // `git add -A` can run clean filters from a nested repository's private config and
    // info/attributes. Refuse those entries before invoking it; gitlinks are never imported.
    // A nested repository without a commit makes `git add` fail; leave those out.
    const skipped: string[] = [];
    const baseSubmoduleExcludes = [...baseLinks.keys()].map(
      (path) => `:(exclude,top,literal)${path}`,
    );
    for (;;) {
      const add = await checkedWorktreeGit(
        wt,
        [
          "add",
          "-A",
          "--",
          ".",
          ...baseSubmoduleExcludes,
          ...skipped.map((p) => `:(exclude,top,literal)${p}`),
        ],
        env,
        CHECKOUT_TIMEOUT_MS,
      );
      if (add.code === 0) break;
      const fresh = [...add.err.matchAll(/'([^']+?)\/?' does not have a commit checked out/g)]
        .map((m) => m[1]!)
        .filter((p) => !skipped.includes(p));
      if (fresh.length === 0) throw new Error(`git add failed: ${add.err || add.out}`);
      skipped.push(...fresh);
    }
    // Nested repositories with commits become gitlinks; their objects are not in this repo.
    const gitlinks = (await run(["diff-index", "--cached", "--raw", wt.base]))
      .split("\n")
      .filter((l) => /^:\d+ 160000 /.test(l))
      .map((l) => l.split("\t")[1]!)
      .filter(Boolean);
    if (gitlinks.length > 0) {
      throw new Error(`refusing to snapshot gitlink entries: ${gitlinks.join(", ")}`);
    }
    const tree = await run(["write-tree"], CHECKOUT_TIMEOUT_MS);
    const unsaved = skipped;

    const parents = ["-p", head];
    if (!onTaskBranch) {
      const prior = await git(workingDir, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (prior.code === 0 && prior.out) parents.push("-p", prior.out);
    }

    // Fresh machines and CI may have no committer identity configured.
    const ident =
      (await checkedWorktreeGit(wt, ["var", "GIT_COMMITTER_IDENT"])).code === 0 &&
      (await checkedWorktreeGit(wt, ["var", "GIT_AUTHOR_IDENT"])).code === 0;
    const identArgs = ident
      ? []
      : ["-c", "user.name=boof-runner", "-c", "user.email=boof-runner@localhost"];
    const sha = await run([
      ...identArgs,
      "commit-tree",
      tree,
      ...parents,
      "-m",
      onTaskBranch ? `boof: ${title}` : `boof-runner leftovers: ${title}`,
    ]);
    if (onTaskBranch) {
      // Compare-and-swap against the head the snapshot was built on; then bring the
      // worktree's own index in line with the new head (files stay as they are).
      await run(["update-ref", `refs/heads/${branch}`, sha, head]);
      const reset = await checkedWorktreeGit(
        wt,
        ["reset", "-q", "--mixed", "HEAD"],
        undefined,
        CHECKOUT_TIMEOUT_MS,
      );
      if (reset.code !== 0) throw new Error(`git reset failed: ${reset.err || reset.out}`);
    } else {
      await run(["update-ref", `refs/heads/${branch}`, sha]);
    }
    return { branch, sha, unsaved };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Remove the worktree directory (leftovers included) and delete the task branches. */
async function deleteWork(workingDir: string, wt: Worktree, why: string): Promise<string[]> {
  const lines: string[] = [];
  const remove = await git(
    workingDir,
    ["worktree", "remove", "--force", wt.path],
    undefined,
    CHECKOUT_TIMEOUT_MS,
  );
  if (remove.code !== 0 && (await pathExists(wt.path))) {
    return [`Kept worktree ${wt.path}: git worktree remove failed: ${remove.err || remove.out}`];
  }
  const branches = [wt.branch];
  if (await localBranchExists(workingDir, leftoversBranch(wt))) branches.push(leftoversBranch(wt));
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
 * Commits onto the task branch only with `snapshotOnTaskBranch` (plan tasks). Never throws; returns log lines. On any
 * failure the directory is kept.
 */
export async function finalizeWorktree(
  workingDir: string,
  wt: Worktree,
  title: string,
  policy: DonePolicy = "keep-branch",
  opts: { snapshotOnTaskBranch?: boolean } = {},
): Promise<string[]> {
  try {
    await verifyWorktreeRecord(wt);
  } catch (err) {
    return [`Kept worktree ${wt.path}: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (policy === "delete") return deleteWork(workingDir, wt, "onDone=delete");

  // A detached or switched HEAD would leave commits unreferenced once the directory is removed.
  const head = await checkedWorktreeGit(wt, ["symbolic-ref", "--quiet", "HEAD"]);
  if (head.code !== 0 || head.out !== `refs/heads/${wt.branch}`) {
    return [`Kept worktree ${wt.path}: HEAD is not on ${wt.branch} (${head.out || "detached"})`];
  }
  const lines: string[] = [];
  try {
    const left = await commitLeftovers(workingDir, wt, title, {
      onTaskBranch: opts.snapshotOnTaskBranch === true,
    });
    if (left) {
      lines.push(
        opts.snapshotOnTaskBranch
          ? `Uncommitted work snapshotted onto task branch ${left.branch} at ${left.sha}`
          : `Leftovers committed to ${left.branch} at ${left.sha}`,
      );
    }
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
  const remove = await git(
    workingDir,
    ["worktree", "remove", "--force", wt.path],
    undefined,
    CHECKOUT_TIMEOUT_MS,
  );
  if (remove.code !== 0) {
    lines.push(`Kept worktree ${wt.path}: git worktree remove failed: ${remove.err || remove.out}`);
    return lines;
  }
  lines.push(`Removed worktree directory ${wt.path} (branch ${wt.branch} kept)`);
  return lines;
}

function strict(wt: Worktree): boolean {
  return wt.strict !== false;
}

export async function verifyWorktreeRecord(wt: Worktree): Promise<void> {
  if (!wt.commonDir || !wt.worktreeName) {
    throw new Error("task worktree is missing its trusted git record");
  }
  await refuseSymlinks(join(wt.commonDir, "logs"));
  const dotGit = join(wt.path, ".git");
  const dotInfo = await lstat(dotGit).catch(() => null);
  if (!dotInfo?.isFile() || dotInfo.isSymbolicLink()) {
    throw new Error("task worktree .git entry was altered");
  }
  const match = /^gitdir:\s*(.+)\s*$/.exec((await readFile(dotGit, "utf8")).trim());
  if (!match?.[1]) throw new Error("task worktree .git file was altered");
  const admin = await realpath(resolve(wt.path, match[1])).catch(() => null);
  const expected = await realpath(join(wt.commonDir, "worktrees", wt.worktreeName)).catch(
    () => null,
  );
  if (!admin || admin !== expected)
    throw new Error("task worktree gitdir differs from the runner record");
  await refuseSymlinks(join(admin, "logs"));
  const worktreeConfigEnabled = await git(
    wt.path,
    [
      "config",
      "--file",
      join(wt.commonDir, "config"),
      "--type=bool",
      "--get",
      "extensions.worktreeConfig",
    ],
    worktreeGitEnv(wt),
  );
  if (strict(wt)) {
    if (worktreeConfigEnabled.code === 0 && worktreeConfigEnabled.out.trim() === "true") {
      throw new Error(
        "task worktree extensions.worktreeConfig is not allowed while the sandbox is enforced; " +
          "turn it off in the repository (git config --unset extensions.worktreeConfig) or switch the sandbox off",
      );
    }
    if (worktreeConfigEnabled.code !== 0 && worktreeConfigEnabled.code !== 1) {
      throw new Error("could not parse common git extensions.worktreeConfig setting");
    }
    const worktreeConfig = join(admin, "config.worktree");
    const worktreeConfigInfo = await lstat(worktreeConfig).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (worktreeConfigInfo) {
      throw new Error("task worktree config.worktree is not allowed while the sandbox is enforced");
    }
  }
  const commonFile = join(admin, "commondir");
  const commonInfo = await lstat(commonFile).catch(() => null);
  if (!commonInfo?.isFile() || commonInfo.isSymbolicLink())
    throw new Error("task worktree commondir was altered");
  const common = await realpath(resolve(admin, (await readFile(commonFile, "utf8")).trim())).catch(
    () => null,
  );
  if (common !== wt.commonDir)
    throw new Error("task worktree commondir differs from the runner record");
  const backref = join(admin, "gitdir");
  const backInfo = await lstat(backref).catch(() => null);
  if (!backInfo?.isFile() || backInfo.isSymbolicLink())
    throw new Error("task worktree admin gitdir was altered");
  const registered = await realpath(resolve(admin, (await readFile(backref, "utf8")).trim())).catch(
    () => null,
  );
  if (registered !== (await realpath(dotGit)))
    throw new Error("task worktree admin gitdir differs from the runner record");
}

async function refuseSymlinks(root: string): Promise<void> {
  const info = await lstat(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error(`git reflog path contains a symlink: ${root}`);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await refuseSymlinks(join(root, entry.name));
  }
}

async function removeTaskBranchReflog(commonDir: string, branch: string): Promise<void> {
  await refuseSymlinks(join(commonDir, "logs"));
  const path = join(commonDir, "logs", "refs", "heads", ...branch.split("/"));
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`task branch reflog is not a regular file: ${path}`);
  }
  await unlink(path);
}

export async function checkedWorktreeGit(
  wt: Worktree,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<Awaited<ReturnType<typeof git>>> {
  await verifyWorktreeRecord(wt);
  const commandIndex = args.findIndex((arg) => ["status", "diff", "add"].includes(arg));
  if (commandIndex >= 0 && strict(wt)) await refuseTaskSubmodules(wt, env);
  const trustedEnv = {
    ...process.env,
    ...env,
    GIT_DIR: join(wt.commonDir!, "worktrees", wt.worktreeName!),
    GIT_COMMON_DIR: wt.commonDir!,
    GIT_WORK_TREE: wt.path,
    GIT_INDEX_FILE:
      env?.GIT_INDEX_FILE ?? join(wt.commonDir!, "worktrees", wt.worktreeName!, "index"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  return git(wt.path, args, trustedEnv, timeoutMs);
}

async function refuseTaskSubmodules(wt: Worktree, extraEnv?: NodeJS.ProcessEnv): Promise<void> {
  const modulesOnDisk = await lstat(join(wt.path, ".gitmodules")).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    },
  );
  const [index, head, base, modulesIndex, modulesHead, modulesBase] = await Promise.all([
    git(wt.path, ["ls-files", "--stage", "-z"], worktreeGitEnv(wt, extraEnv)),
    git(wt.path, ["ls-tree", "-r", "-z", "HEAD"], worktreeGitEnv(wt, extraEnv)),
    git(wt.path, ["ls-tree", "-r", "-z", wt.base], worktreeGitEnv(wt, extraEnv)),
    git(wt.path, ["ls-files", "--stage", "--", ".gitmodules"], worktreeGitEnv(wt, extraEnv)),
    git(wt.path, ["ls-tree", "-z", "HEAD", "--", ".gitmodules"], worktreeGitEnv(wt, extraEnv)),
    git(wt.path, ["ls-tree", "-z", wt.base, "--", ".gitmodules"], worktreeGitEnv(wt, extraEnv)),
  ]);
  if (
    [index, head, base, modulesIndex, modulesHead, modulesBase].some((result) => result.code !== 0)
  ) {
    throw new Error("could not verify task worktree submodule state");
  }
  const baseLinks = new Map(
    gitlinksFromTree(base.out.split("\0").filter((entry) => /^160000 commit /.test(entry))),
  );
  const indexLinks = gitlinksFromIndex(index.out.split("\0"));
  const headLinks = gitlinksFromTree(
    head.out.split("\0").filter((entry) => /^160000 commit /.test(entry)),
  );
  const addedLinks = [...indexLinks, ...headLinks].filter(
    ([path, oid]) => baseLinks.get(path) !== oid,
  );
  const baseHasModules = !!modulesBase.out;
  const modulesAdded =
    !baseHasModules && (modulesOnDisk || !!modulesIndex.out || !!modulesHead.out);
  if (addedLinks.length > 0 || modulesAdded) {
    throw new Error("refusing task worktree git command with gitlinks or .gitmodules");
  }
}

function treePath(entry: string): string {
  return entry.slice(entry.indexOf("\t") + 1);
}

function gitlinksFromTree(entries: string[]): [string, string][] {
  return entries.map((entry) => {
    const header = entry.slice(0, entry.indexOf("\t")).split(" ");
    return [treePath(entry), header[2] ?? ""];
  });
}

function gitlinksFromIndex(entries: string[]): [string, string][] {
  return entries
    .filter((entry) => /^160000 /.test(entry))
    .map((entry) => {
      const header = entry.slice(0, entry.indexOf("\t")).split(" ");
      return [treePath(entry), header[1] ?? ""];
    });
}

function worktreeGitEnv(wt: Worktree, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    GIT_DIR: join(wt.commonDir!, "worktrees", wt.worktreeName!),
    GIT_COMMON_DIR: wt.commonDir!,
    GIT_WORK_TREE: wt.path,
    GIT_INDEX_FILE:
      extraEnv?.GIT_INDEX_FILE ?? join(wt.commonDir!, "worktrees", wt.worktreeName!, "index"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function worktreeUntrackedFiles(wt: Worktree): Promise<string[]> {
  const result = await checkedWorktreeGit(wt, [
    "--literal-pathspecs",
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (result.code !== 0) {
    throw new Error(`could not list untracked files in ${wt.path}: ${result.err || result.code}`);
  }
  return result.out.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED);
}

async function worktreeUntrackedPatch(wt: Worktree, path: string, context = 3): Promise<string> {
  const result = await checkedWorktreeGit(wt, [
    "--literal-pathspecs",
    "diff",
    `-U${context}`,
    "--no-index",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    "/dev/null",
    path,
  ]);
  return result.out;
}

/** Delete a failed task's directory and branch (settings.worktree.onFailure=delete). Never throws. */
export async function discardWorktree(workingDir: string, wt: Worktree): Promise<string[]> {
  return deleteWork(workingDir, wt, "onFailure=delete");
}
