/**
 * Structured review results derived from a task's reports (`body.reports.observer` and
 * `body.reports.reviewer`). The task file format is unchanged: this only parses the
 * `#### Round N — VERDICT (iteration K)` blocks the pipeline already writes.
 */
import type { Task } from "./task-types.js";

export type ReviewRole = "observer" | "reviewer";
export type ReviewVerdict = "APPROVE" | "CHANGES_REQUESTED" | "REJECT" | "INVALID";

export interface TaskReview {
  role: ReviewRole;
  round: number;
  iteration: number;
  verdict: ReviewVerdict;
  /** First non-empty, non-heading line of the round's report. */
  summary: string;
}

export interface TaskReviewInfo {
  reviews: TaskReview[];
  /** The verdict of the last round of each role that reviewed. */
  finalVerdict: { observer?: ReviewVerdict; reviewer?: ReviewVerdict };
  /** `boof-runner/<id>` when the task ran in a git worktree. */
  branch?: string;
  /** The commit the task's worktree started from, when the task log recorded it. */
  baseSha?: string;
}

const HEADER =
  /^#### Round (\d+) — (APPROVE|CHANGES_REQUESTED|REJECT|INVALID)(?: \(iteration (\d+)\))?\s*$/;
const SUMMARY_MAX = 400;

/** The rounds of one report, oldest first. Blocks with an unreadable header are skipped. */
export function parseReviewRounds(role: ReviewRole, report: string): TaskReview[] {
  const out: TaskReview[] = [];
  for (const block of report.split(/(?=^#### Round )/m)) {
    const lines = block.trim().split("\n");
    const m = HEADER.exec(lines[0] ?? "");
    if (!m) continue;
    const summary =
      lines
        .slice(1)
        .map((l) => l.trim())
        .find((l) => l !== "" && !l.startsWith("#")) ?? "";
    out.push({
      role,
      round: Number(m[1]),
      iteration: m[3] ? Number(m[3]) : 1,
      verdict: m[2] as ReviewVerdict,
      summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    });
  }
  return out;
}

/** Observer rounds first, then reviewer rounds, each oldest first. */
export function taskReviewInfo(task: Task): TaskReviewInfo {
  const observer = parseReviewRounds("observer", task.body.reports.observer);
  const reviewer = parseReviewRounds("reviewer", task.body.reports.reviewer);
  const finalVerdict: TaskReviewInfo["finalVerdict"] = {};
  if (observer.length > 0) finalVerdict.observer = observer[observer.length - 1]!.verdict;
  if (reviewer.length > 0) finalVerdict.reviewer = reviewer[reviewer.length - 1]!.verdict;
  const log = task.body.log;
  const shas = [...log.matchAll(/^base \S+ → ([0-9a-f]{7,64})\s*$/gm)];
  const baseSha = shas.length > 0 ? shas[shas.length - 1]![1] : undefined;
  const inWorktree = /worktree at /.test(log) || baseSha !== undefined;
  return {
    reviews: [...observer, ...reviewer],
    finalVerdict,
    ...(inWorktree ? { branch: `boof-runner/${task.frontmatter.id}` } : {}),
    ...(baseSha ? { baseSha } : {}),
  };
}
