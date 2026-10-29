import { stat } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { execCommand } from "./exec.js";
import { untrackedFiles as listUntracked, untrackedPatch } from "./untracked-diff.js";
import { leftoversBranch, registeredWorktreeBranch } from "./worktree.js";

const BRANCH_PREFIX = "boof-runner/";
const MAX_COMMITS = 200;

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
}

export interface DiffCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface TaskDiff {
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  files: DiffFile[];
  stats: { files: number; additions: number; deletions: number };
  patch?: string;
  truncated: boolean;
  commits: DiffCommit[];
  includesUncommitted?: boolean;
  leftovers?: { ref: string; sha: string };
}

export interface TaskDiffOptions {
  /** The project's repository (git cwd for everything except the live worktree). */
  workingDir: string;
  taskId: string;
  /** Commit the task's worktree started from, when recorded. */
  baseSha?: string;
  /** Ref the worktree started from; used to find the merge-base when baseSha is missing. */
  baseRef?: string;
  /** Directory where this task's worktree would live (`<root>/<taskId>`). */
  worktreePath?: string;
  /** Repo-relative file: only that file's patch is returned. */
  path?: string;
  context?: number;
  maxBytes?: number;
}

export const DEFAULT_DIFF_MAX_BYTES = 400_000;

export class BranchNotFoundError extends Error {
  constructor(public readonly branch: string) {
    super(`Branch ${branch} does not exist (deleted, or the task never ran in a worktree)`);
    this.name = "BranchNotFoundError";
  }
}

export class InvalidDiffPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDiffPathError";
  }
}

/** Throws InvalidDiffPathError unless `p` is a plain repo-relative path (no `..`, not absolute). */
export function assertRepoRelativePath(p: string): string {
  if (p === "" || p.includes("\0") || p.includes("\\")) {
    throw new InvalidDiffPathError("path must be a repo-relative file path");
  }
  if (isAbsolute(p) || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    throw new InvalidDiffPathError("path must be relative to the repository, not absolute");
  }
  const norm = posix.normalize(p);
  if (norm === "." || p.split("/").includes("..") || norm.startsWith("../")) {
    throw new InvalidDiffPathError("path must stay inside the repository (no '..')");
  }
  return norm;
}

async function git(cwd: string, args: string[]) {
  // Read-only plumbing; --literal-pathspecs keeps file names from acting as pathspec magic.
  const res = await execCommand(
    "git",
    ["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=off", ...args],
    { cwd, timeoutMs: 30000 },
  );
  return { code: res.code, out: res.stdout, err: res.stderr.trim() };
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const res = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const sha = res.out.trim();
  return res.code === 0 && sha ? sha : null;
}

interface RawStatus {
  status: DiffFileStatus;
  path: string;
  oldPath?: string;
}

function parseNameStatus(out: string): RawStatus[] {
  const parts = out.split("\0");
  const res: RawStatus[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++]!;
      const path = parts[i++]!;
      res.push(letter === "R" ? { status: "renamed", path, oldPath } : { status: "added", path });
    } else {
      const path = parts[i++]!;
      res.push({
        status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
        path,
      });
    }
  }
  return res;
}

/** path -> [additions, deletions], or null for a binary file. */
function parseNumstat(out: string): Map<string, [number, number] | null> {
  const parts = out.split("\0");
  const res = new Map<string, [number, number] | null>();
  for (let i = 0; i < parts.length;) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(head);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") {
      i++; // old path of a rename
      path = parts[i++]!;
    }
    res.set(path, m[1] === "-" ? null : [Number(m[1]), Number(m[2])]);
  }
  return res;
}

function mergeFiles(names: RawStatus[], nums: Map<string, [number, number] | null>): DiffFile[] {
  return names.map((n) => {
    const num = nums.get(n.path);
    return {
      path: n.path,
      ...(n.oldPath ? { oldPath: n.oldPath } : {}),
      status: num === null ? "binary" : n.status,
      additions: num?.[0] ?? 0,
      deletions: num?.[1] ?? 0,
    };
  });
}

/**
 * What a task changed: the task branch against its base, plus the uncommitted changes of a live
 * worktree. Strictly read-only: only git diff/log/rev-parse/status/ls-files/merge-base run.
 */
export async function taskDiff(opts: TaskDiffOptions): Promise<TaskDiff> {
  const { workingDir, taskId } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const context = opts.context ?? 3;
  const onlyPath = opts.path === undefined ? undefined : assertRepoRelativePath(opts.path);
  const branch = `${BRANCH_PREFIX}${taskId}`;

  const headSha = await revParse(workingDir, `refs/heads/${branch}`);
  if (!headSha) throw new BranchNotFoundError(branch);

  // Base: the recorded start commit, else where the branch left baseRef / HEAD.
  let baseSha: string | null = null;
  let baseLabel = opts.baseRef ?? "HEAD";
  if (opts.baseSha && /^[0-9a-f]{7,64}$/i.test(opts.baseSha)) {
    baseSha = await revParse(workingDir, opts.baseSha);
    if (baseSha && !opts.baseRef) baseLabel = opts.baseSha.slice(0, 12);
  }
  if (!baseSha) {
    const candidates = [opts.baseRef, "HEAD"].filter((r): r is string => !!r && !r.startsWith("-"));
    for (const ref of candidates) {
      const mb = await git(workingDir, ["merge-base", ref, `refs/heads/${branch}`]);
      if (mb.code === 0 && mb.out.trim()) {
        baseSha = mb.out.trim();
        baseLabel = ref;
        break;
      }
    }
  }
  if (!baseSha) baseSha = headSha; // unrelated histories: no committed changes to show

  // Live worktree on the task branch: its working tree counts too.
  let liveWt: string | null = null;
  if (opts.worktreePath) {
    const isDir = await stat(opts.worktreePath).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (isDir && (await registeredWorktreeBranch(workingDir, opts.worktreePath)) === branch) {
      liveWt = opts.worktreePath;
    }
  }
  let includesUncommitted = false;
  if (liveWt) {
    const st = await git(liveWt, ["status", "--porcelain"]);
    includesUncommitted = st.code === 0 && st.out.trim() !== "";
  }

  const cwd = includesUncommitted ? liveWt! : workingDir;
  const range = includesUncommitted ? [baseSha] : [baseSha, headSha];
  const names = parseNameStatus(
    (await git(cwd, ["diff", "--name-status", "-M", "-z", ...range])).out,
  );
  const nums = parseNumstat((await git(cwd, ["diff", "--numstat", "-M", "-z", ...range])).out);
  const files = mergeFiles(names, nums);

  // Untracked files of the live worktree, diffed against nothing (no objects are written).
  const untrackedFiles: DiffFile[] = [];
  if (includesUncommitted) {
    const un = await listUntracked(liveWt!);
    const known = new Set(files.map((f) => f.path));
    for (const p of un) {
      if (known.has(p)) continue;
      const ns = await git(liveWt!, [
        "diff",
        "--no-index",
        "--numstat",
        "-z",
        "--",
        "/dev/null",
        p,
      ]);
      const n = [...parseNumstat(ns.out).values()][0];
      untrackedFiles.push({
        path: p,
        status: n === null ? "binary" : "added",
        additions: n?.[0] ?? 0,
        deletions: 0,
      });
    }
  }
  const all = [...files, ...untrackedFiles].sort((a, b) => a.path.localeCompare(b.path));
  const stats = {
    files: all.length,
    additions: all.reduce((s, f) => s + f.additions, 0),
    deletions: all.reduce((s, f) => s + f.deletions, 0),
  };

  const patchFor = async (sel: DiffFile[] | null): Promise<string> => {
    const tracked = sel ? sel.filter((f) => !untrackedFiles.includes(f)) : null;
    const untr = sel ? sel.filter((f) => untrackedFiles.includes(f)) : untrackedFiles;
    let text = "";
    if (tracked === null || tracked.length > 0) {
      const args = ["diff", `-U${context}`, "-M", "--no-ext-diff", "--no-textconv", ...range];
      if (tracked) {
        args.push("--", ...tracked.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])));
      }
      text = (await git(cwd, args)).out;
    }
    for (const f of untr) {
      const d = await untrackedPatch(liveWt!, f.path, context);
      text += (text && !text.endsWith("\n") ? "\n" : "") + d;
    }
    return text;
  };

  let patch: string | undefined;
  let truncated = false;
  if (onlyPath !== undefined) {
    const f = all.find((x) => x.path === onlyPath || x.oldPath === onlyPath);
    const text = f ? await patchFor([f]) : "";
    if (Buffer.byteLength(text) > maxBytes) {
      patch = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
      truncated = true;
    } else {
      patch = text;
    }
  } else {
    const text = await patchFor(null);
    if (Buffer.byteLength(text) > maxBytes) truncated = true;
    else patch = text;
  }

  const log = await git(workingDir, [
    "log",
    `--max-count=${MAX_COMMITS}`,
    "--format=%H%x1f%s%x1f%an%x1f%aI%x1e",
    `${baseSha}..${headSha}`,
  ]);
  const commits: DiffCommit[] = log.out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha = "", subject = "", author = "", date = ""] = r.split("\x1f");
      return { sha, subject, author, date };
    });

  const lb = leftoversBranch({ branch, path: "", base: "" });
  const leftSha = await revParse(workingDir, `refs/heads/${lb}`);

  return {
    base: { ref: baseLabel, sha: baseSha },
    head: { ref: branch, sha: headSha },
    files: all,
    stats,
    ...(patch !== undefined ? { patch } : {}),
    truncated,
    commits,
    ...(includesUncommitted ? { includesUncommitted: true } : {}),
    ...(leftSha ? { leftovers: { ref: lb, sha: leftSha } } : {}),
  };
}
