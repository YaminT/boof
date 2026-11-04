import type { TaskView } from "../api.js";

/**
 * What the Overview shows. Simple keeps the Now lane (always) and whatever went wrong: failed or
 * stopped tasks from Recent, and the spend line once the limit is exceeded. Expanded adds the rest.
 */
export function overviewParts(
  expanded: boolean,
  recent: TaskView[],
  spendExceeded: boolean,
): { recent: TaskView[]; showRecent: boolean; showSpend: boolean } {
  if (expanded) return { recent, showRecent: true, showSpend: true };
  const wrong = recent.filter((t) => ["failed", "stopped"].includes(t.frontmatter.status));
  return { recent: wrong, showRecent: wrong.length > 0, showSpend: spendExceeded };
}

/**
 * Whether the task form is shown. Expanded always shows it. Simple tucks it behind a disclosure,
 * but never while it holds unsaved edits, a refused save or a newer server copy.
 */
export function taskFormOpen(
  expanded: boolean,
  disclosed: boolean,
  needsAttention: boolean,
): boolean {
  return expanded || disclosed || needsAttention;
}
