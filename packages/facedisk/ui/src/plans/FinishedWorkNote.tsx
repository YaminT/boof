import type { Goal } from "../api.js";
import { finishedWork } from "../lib/finished-work.js";

/** Shown on a finished plan: the work is on a boof-runner branch, not on main. */
export function FinishedWorkNote({ goals }: { goals: readonly Goal[] }) {
  const work = finishedWork(goals);
  if (!work) return null;
  return (
    <p
      data-testid="finished-work-note"
      className="m-0 max-w-[80ch] rounded-[10px] border border-line bg-surface p-3 text-[length:var(--text-row)] text-ink"
    >
      Done. The finished work is on the branch <code>{work.branch}</code>, not on your main branch
      yet. To use it, switch to your main branch and run <code>{work.mergeCommand}</code>.
    </p>
  );
}
