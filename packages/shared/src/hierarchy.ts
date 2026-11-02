/**
 * Task hierarchy rules: project → epic (optional) → task → subtask (optional, one level).
 *
 * Lock order, outermost first: the hierarchy lock (`withHierarchyLock`, one per project), then
 * the task lock inside `TaskStore`, then the `epics.json` file lock inside `EpicStore`. Never take
 * the hierarchy lock inside a `modify`/`transition` callback or inside `EpicStore`.
 *
 * The lock is in-process, like `lockTask`. A second process (the CLI beside the server) can still
 * race a mutation; that is covered by dangling-reference tolerance (a missing parent or epic
 * loads fine and is flagged `parentMissing` / `epicMissing`), not by the lock.
 *
 * Only this module writes `epicId` and `parentId`, always through `TaskStore.modify`, so
 * `TaskStore.save` can keep the disk values against a stale copy.
 */
import { withFileLock } from "./atomic.js";
import { EpicStore } from "./epic-store.js";
import { appendEvent } from "./events.js";
import { basename } from "node:path";
import type { Epic } from "./schema.js";
import { TaskNotFoundError, TaskStore } from "./store.js";
import type { Task } from "./task-file.js";

/** The filter value that means "no epic" / "no parent". */
export const HIERARCHY_NONE = "none";

export type HierarchyErrorCode =
  "epic_not_found" | "parent_not_found" | "invalid_hierarchy" | "has_children" | "has_tasks";

export class HierarchyError extends Error {
  constructor(
    public readonly code: HierarchyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HierarchyError";
  }
}

export function withHierarchyLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${projectDir}#hierarchy`, fn);
}

/** Tasks: priority descending, then updated ascending, then id ascending (the scheduler's order). */
export function compareTasks(a: Task, b: Task): number {
  const x = a.frontmatter;
  const y = b.frontmatter;
  return (
    y.priority - x.priority ||
    (x.updated < y.updated ? -1 : x.updated > y.updated ? 1 : 0) ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  );
}

export interface TaskHierarchyInfo {
  /** The effective epic: the parent's stored epic for a subtask, else the task's own. */
  epicId?: string;
  /** Present only when the task has non-archived subtasks. */
  subtasks?: { total: number; done: number };
  parentMissing?: true;
  epicMissing?: true;
}

export interface HierarchyIndex {
  info(task: Task): TaskHierarchyInfo;
  effectiveEpicId(task: Task): string | undefined;
  /** No `parentId`, or the parent does not exist. */
  isTopLevel(task: Task): boolean;
  /** Sorted by `compareTasks`; archived ones included. */
  childrenOf(id: string): Task[];
  epicProgress(epicId: string): { total: number; done: number };
}

/** `epics` must include archived epics: an archived epic still exists. */
export function buildHierarchyIndex(tasks: Task[], epics: Epic[]): HierarchyIndex {
  const byId = new Map(tasks.map((t) => [t.frontmatter.id, t]));
  const epicIds = new Set(epics.map((e) => e.id));
  const children = new Map<string, Task[]>();
  for (const t of tasks) {
    const p = t.frontmatter.parentId;
    if (p !== undefined && byId.has(p)) {
      const list = children.get(p) ?? [];
      list.push(t);
      children.set(p, list);
    }
  }
  for (const list of children.values()) list.sort(compareTasks);

  const parentOf = (t: Task) => {
    const p = t.frontmatter.parentId;
    return p === undefined ? undefined : byId.get(p);
  };
  const isTopLevel = (t: Task) => parentOf(t) === undefined;
  // One hop only: the parent's own parentId is ignored, so cycles terminate.
  const effectiveEpicId = (t: Task) => (parentOf(t) ?? t).frontmatter.epicId;
  const progress = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    const e = t.frontmatter.epicId;
    if (e === undefined || !isTopLevel(t) || t.frontmatter.status === "archived") continue;
    const p = progress.get(e) ?? { total: 0, done: 0 };
    p.total += 1;
    if (t.frontmatter.status === "done") p.done += 1;
    progress.set(e, p);
  }

  return {
    effectiveEpicId,
    isTopLevel,
    childrenOf: (id) => children.get(id) ?? [],
    epicProgress: (id) => ({ ...(progress.get(id) ?? { total: 0, done: 0 }) }),
    info(t) {
      const out: TaskHierarchyInfo = {};
      const epicId = effectiveEpicId(t);
      if (epicId !== undefined) out.epicId = epicId;
      const kids = (children.get(t.frontmatter.id) ?? []).filter(
        (c) => c.frontmatter.status !== "archived",
      );
      if (kids.length > 0) {
        out.subtasks = {
          total: kids.length,
          done: kids.filter((c) => c.frontmatter.status === "done").length,
        };
      }
      if (t.frontmatter.parentId !== undefined && !byId.has(t.frontmatter.parentId)) {
        out.parentMissing = true;
      }
      if (epicId !== undefined && !epicIds.has(epicId)) out.epicMissing = true;
      return out;
    },
  };
}

export interface HierarchyFilter {
  epic?: string;
  parent?: string;
}

export function matchesHierarchy(
  task: Task,
  index: HierarchyIndex,
  filter: HierarchyFilter,
): boolean {
  if (filter.epic !== undefined) {
    const e = index.effectiveEpicId(task);
    if (filter.epic === HIERARCHY_NONE ? e !== undefined : e !== filter.epic) return false;
  }
  if (filter.parent !== undefined) {
    if (filter.parent === HIERARCHY_NONE) {
      if (!index.isTopLevel(task)) return false;
    } else if (task.frontmatter.parentId !== filter.parent) return false;
  }
  return true;
}

const bad = (code: HierarchyErrorCode, message: string) => new HierarchyError(code, message);

async function load(projectDir: string) {
  const store = new TaskStore(projectDir);
  const epics = new EpicStore(projectDir);
  const tasks = await store.list();
  const all = await epics.list({ includeArchived: true });
  return { store, epics, tasks, all, index: buildHierarchyIndex(tasks, all) };
}

const moved = (
  projectDir: string,
  task: string,
  from: { epicId?: string; parentId?: string },
  to: { epicId?: string; parentId?: string },
  by?: string,
) =>
  appendEvent(projectDir, {
    type: "task.moved",
    project: basename(projectDir),
    task,
    from: { epicId: from.epicId ?? null, parentId: from.parentId ?? null },
    to: { epicId: to.epicId ?? null, parentId: to.parentId ?? null },
    by: by ?? "runner",
  });

export async function createTaskInHierarchy(
  projectDir: string,
  task: Task,
  opts: { by?: string } = {},
): Promise<Task> {
  const { epicId, parentId } = task.frontmatter;
  if (epicId === undefined && parentId === undefined) {
    return new TaskStore(projectDir).createUnique(task, opts);
  }
  return withHierarchyLock(projectDir, async () => {
    const { store, all, tasks } = await load(projectDir);
    if (epicId !== undefined && parentId !== undefined) {
      throw bad("invalid_hierarchy", "a subtask has no epic of its own");
    }
    if (epicId !== undefined && !all.some((e) => e.id === epicId)) {
      throw bad("epic_not_found", `Epic not found: ${epicId}`);
    }
    if (parentId !== undefined) {
      const parent = tasks.find((t) => t.frontmatter.id === parentId);
      if (!parent) throw bad("parent_not_found", `Parent task not found: ${parentId}`);
      if (parent.frontmatter.parentId !== undefined) {
        throw bad("invalid_hierarchy", "a subtask cannot have subtasks");
      }
    }
    return store.createUnique(task, opts);
  });
}

export interface MoveInput {
  /** `undefined` keeps, `null` clears. */
  epicId?: string | null;
  parentId?: string | null;
}

export async function moveTask(
  projectDir: string,
  id: string,
  input: MoveInput,
  opts: { by?: string } = {},
): Promise<Task> {
  return withHierarchyLock(projectDir, async () => {
    const { store, all, tasks, index } = await load(projectDir);
    const current = tasks.find((t) => t.frontmatter.id === id);
    if (!current) throw new TaskNotFoundError(id);
    const from = { epicId: current.frontmatter.epicId, parentId: current.frontmatter.parentId };
    if (typeof input.parentId === "string" && typeof input.epicId === "string") {
      throw bad("invalid_hierarchy", "a subtask takes its parent's epic; pass one of the two");
    }
    let parentId = from.parentId;
    let epicId = from.epicId;
    if (typeof input.parentId === "string") {
      const parent = tasks.find((t) => t.frontmatter.id === input.parentId);
      if (input.parentId === id) throw bad("invalid_hierarchy", "a task cannot be its own parent");
      if (!parent) throw bad("parent_not_found", `Parent task not found: ${input.parentId}`);
      if (parent.frontmatter.parentId !== undefined) {
        throw bad("invalid_hierarchy", "a subtask cannot have subtasks");
      }
      if (index.childrenOf(id).length > 0) {
        throw bad("has_children", "a task with subtasks cannot become a subtask");
      }
      parentId = input.parentId;
      epicId = undefined;
    } else if (input.parentId === null) {
      parentId = undefined;
    }
    if (typeof input.epicId === "string") {
      if (!all.some((e) => e.id === input.epicId)) {
        throw bad("epic_not_found", `Epic not found: ${input.epicId}`);
      }
      if (parentId !== undefined && tasks.some((t) => t.frontmatter.id === parentId)) {
        throw bad(
          "invalid_hierarchy",
          "a subtask takes its parent's epic; pass parentId: null to detach it",
        );
      }
      epicId = input.epicId;
    } else if (input.epicId === null) {
      epicId = undefined;
    }
    if (parentId === from.parentId && epicId === from.epicId) return current;
    const saved = await store.modify(id, (t) => {
      if (parentId === undefined) delete t.frontmatter.parentId;
      else t.frontmatter.parentId = parentId;
      if (epicId === undefined) delete t.frontmatter.epicId;
      else t.frontmatter.epicId = epicId;
    });
    await moved(projectDir, id, from, { epicId, parentId }, opts.by);
    return saved;
  });
}

export async function removeTask(
  projectDir: string,
  id: string,
  opts: { detach?: boolean; by?: string } = {},
): Promise<{ detached: string[] }> {
  return withHierarchyLock(projectDir, async () => {
    const { store, tasks, index } = await load(projectDir);
    const task = tasks.find((t) => t.frontmatter.id === id);
    const kids = index.childrenOf(id);
    if (kids.length > 0 && !opts.detach) {
      throw bad(
        "has_children",
        `Task ${id} has ${kids.length} subtask(s); pass detach to keep them`,
      );
    }
    const detached: string[] = [];
    for (const kid of kids) {
      const kidId = kid.frontmatter.id;
      const epicId = task?.frontmatter.epicId;
      await store.modify(kidId, (t) => {
        delete t.frontmatter.parentId;
        if (epicId !== undefined) t.frontmatter.epicId = epicId;
      });
      await moved(projectDir, kidId, { parentId: id }, { epicId }, opts.by);
      detached.push(kidId);
    }
    await store.delete(id);
    return { detached };
  });
}

export async function removeEpic(
  projectDir: string,
  epicId: string,
  opts: { detach?: boolean; by?: string } = {},
): Promise<{ detached: string[] }> {
  return withHierarchyLock(projectDir, async () => {
    const { store, epics, tasks, all } = await load(projectDir);
    if (!all.some((e) => e.id === epicId)) {
      throw bad("epic_not_found", `Epic not found: ${epicId}`);
    }
    const members = tasks.filter((t) => t.frontmatter.epicId === epicId);
    if (members.length > 0 && !opts.detach) {
      throw bad(
        "has_tasks",
        `Epic ${epicId} has ${members.length} task(s); pass detach to clear them`,
      );
    }
    const detached: string[] = [];
    for (const m of members) {
      const tid = m.frontmatter.id;
      await store.modify(tid, (t) => {
        delete t.frontmatter.epicId;
      });
      await moved(
        projectDir,
        tid,
        { epicId, parentId: m.frontmatter.parentId },
        { parentId: m.frontmatter.parentId },
        opts.by,
      );
      detached.push(tid);
    }
    await epics.remove(epicId, { by: opts.by });
    return { detached };
  });
}
