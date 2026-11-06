import type { EpicView, TaskView } from "../api.js";

/** One epic's tasks within a state section; `epic` is null for the tasks without one. */
export interface EpicSection {
  /** The epic id, or `none` for the tasks without an epic. */
  key: string;
  epic: EpicView | null;
  tasks: TaskView[];
  /** The epic's own progress over the whole project, not just the tasks shown here. */
  progress: { done: number; total: number } | null;
  archived: boolean;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Splits a section's tasks by epic: epics by priority (high first), then oldest update, then id,
 * and "No epic" last. An epic with no task here gets no group. A task whose epic no longer
 * exists counts as having none. Tasks keep their order inside a group.
 */
export function groupTasksByEpic(tasks: TaskView[], epics: EpicView[]): EpicSection[] {
  const known = new Map(epics.map((e) => [e.id, e]));
  const buckets = new Map<string, TaskView[]>();
  const push = (key: string, t: TaskView) => buckets.set(key, [...(buckets.get(key) ?? []), t]);
  for (const t of tasks) push(t.epicId && known.has(t.epicId) ? t.epicId : "none", t);

  const ordered = [...known.values()]
    .filter((e) => buckets.has(e.id))
    .sort((a, b) => b.priority - a.priority || cmp(a.updated, b.updated) || cmp(a.id, b.id));
  const out: EpicSection[] = ordered.map((e) => ({
    key: e.id,
    epic: e,
    tasks: buckets.get(e.id)!,
    progress: e.progress,
    archived: e.archived,
  }));
  if (buckets.has("none"))
    out.push({
      key: "none",
      epic: null,
      tasks: buckets.get("none")!,
      progress: null,
      archived: false,
    });
  return out;
}

/**
 * The whole queue order after reordering one group: the group's rows keep the slots they had, in
 * their new order, so other groups do not move and only priorities change, never an epic.
 */
export function reorderWithinGroup(flat: string[], group: string[], next: string[]): string[] {
  const inGroup = new Set(group);
  const queue = next.filter((id) => inGroup.has(id));
  return flat.map((id) => (inGroup.has(id) ? (queue.shift() ?? id) : id));
}

/** The little of `localStorage` the preferences use. */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const groupingKey = (pid: string) => `boof.groupByEpic.${pid}`;
const collapsedKey = (pid: string) => `boof.epicCollapsed.${pid}`;

/** Whether the Tasks list is grouped by epic in this project; off until the user turns it on. */
export function readGrouping(store: PrefStore | null, pid: string): boolean {
  try {
    return store?.getItem(groupingKey(pid)) === "1";
  } catch {
    return false;
  }
}

export function writeGrouping(store: PrefStore | null, pid: string, on: boolean): void {
  try {
    store?.setItem(groupingKey(pid), on ? "1" : "0");
  } catch {
    // Storage may be blocked; the choice then lasts until the page closes.
  }
}

/** Groups the user opened or closed, by epic id (`none` for "No epic"). */
export function readCollapsed(store: PrefStore | null, pid: string): Record<string, boolean> {
  try {
    const raw = JSON.parse(store?.getItem(collapsedKey(pid)) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

export function writeCollapsed(
  store: PrefStore | null,
  pid: string,
  map: Record<string, boolean>,
): void {
  try {
    store?.setItem(collapsedKey(pid), JSON.stringify(map));
  } catch {
    // See writeGrouping.
  }
}

/** The user's choice if they made one; otherwise an archived epic starts collapsed. */
export function isCollapsed(map: Record<string, boolean>, section: EpicSection): boolean {
  return map[section.key] ?? section.archived;
}
