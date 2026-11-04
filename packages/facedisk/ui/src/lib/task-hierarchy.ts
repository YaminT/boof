import type { TaskView } from "../api.js";

/** A task as one row of a section, with what the hierarchy adds to it. */
export interface HierarchyRow {
  task: TaskView;
  /** Shown right under its parent, which is in the same section. */
  child: boolean;
  /** The parent when it is not directly above this row (another section, or filtered out). */
  parentRef: { id: string; title: string } | null;
  /** Subtasks done of total, for a task that has subtasks. */
  progress: { done: number; total: number } | null;
  /** The task names a parent that does not exist. */
  parentMissing: boolean;
  /** The task's effective epic does not exist. */
  epicMissing: boolean;
}

export const progressLabel = (p: { done: number; total: number }) => `${p.done}/${p.total}`;

/**
 * Rows of one section. With `nest` (default), a subtask follows its parent when the parent is in
 * the section; every other subtask keeps its place and names its parent. `all` is every task of
 * the project, used for the parent's title. Without `nest` the order is never changed.
 */
export function groupSubtasks(
  section: TaskView[],
  opts: { all?: TaskView[]; nest?: boolean } = {},
): HierarchyRow[] {
  const nest = opts.nest ?? true;
  const titles = new Map<string, string>();
  for (const t of opts.all ?? []) titles.set(t.frontmatter.id, t.frontmatter.title);
  for (const t of section) titles.set(t.frontmatter.id, t.frontmatter.title);
  const byId = new Map(section.map((t) => [t.frontmatter.id, t]));

  const row = (task: TaskView, child: boolean): HierarchyRow => {
    const parentId = task.frontmatter.parentId;
    const missing = task.parentMissing === true;
    return {
      task,
      child,
      parentRef:
        !child && parentId && !missing
          ? { id: parentId, title: titles.get(parentId) ?? parentId }
          : null,
      progress: task.subtasks && task.subtasks.total > 0 ? task.subtasks : null,
      parentMissing: missing,
      epicMissing: task.epicMissing === true,
    };
  };

  const nested = (t: TaskView) =>
    nest &&
    !t.parentMissing &&
    t.frontmatter.parentId !== undefined &&
    // One level only: a "parent" that is itself a subtask (bad data) never swallows its children.
    byId.get(t.frontmatter.parentId) !== undefined &&
    byId.get(t.frontmatter.parentId)!.frontmatter.parentId === undefined;

  const childrenOf = new Map<string, TaskView[]>();
  for (const t of section) {
    if (!nested(t)) continue;
    const list = childrenOf.get(t.frontmatter.parentId!) ?? [];
    list.push(t);
    childrenOf.set(t.frontmatter.parentId!, list);
  }
  const out: HierarchyRow[] = [];
  for (const t of section) {
    if (nested(t)) continue;
    out.push(row(t, false));
    for (const c of childrenOf.get(t.frontmatter.id) ?? []) out.push(row(c, true));
  }
  return out;
}
