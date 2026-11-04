/**
 * Task hierarchy rules: project → epic (optional) → task → subtask (optional, one level).
 *
 * Lock order, outermost first: the hierarchy lock (`withHierarchyLock`, one per project), then
 * the task lock inside `TaskStore`, then the `epics.json` file lock inside `EpicStore`. Never take
 * the hierarchy lock inside a `modify`/`transition` callback or inside `EpicStore`.
 *
 * All three are pid locks (`withProcessLock`), so they also hold between processes (the CLI and MCP
 * stdio beside the server): `<project>/.locks/hierarchy.lock`, `<project>/tasks/.locks/<id>.lock`,
 * `<project>/.locks/epics.lock`. The order is the same across processes, and nothing that holds a
 * task lock or the epics lock takes the hierarchy lock, so no cycle is possible; the worst case is
 * a 30 s wait and a clear error. A missing parent or epic still loads fine and is flagged
 * `parentMissing` / `epicMissing`, for a file edited by hand or a delete from an older version.
 *
 * The lock is not re-entrant: never call `createTaskInHierarchy`, `moveTask`, `removeTask` or
 * `removeEpic` from inside `withHierarchyLock` (or from anything that holds it); it hangs with no
 * error. A deleted task or epic leaves dangling references only after a cross-process race or a
 * direct delete; a new item that happens to reuse that id adopts them.
 *
 * Only this module writes `epicId` and `parentId`, always through `TaskStore.modify`, so
 * `TaskStore.save` can keep the disk values against a stale copy.
 */
import { EpicStore } from "./epic-store.js";
import { appendEvent } from "./events.js";
import { basename, join, resolve } from "node:path";
import { withProcessLock } from "./process-lock.js";
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
  return withProcessLock(
    join(resolve(projectDir), ".locks", "hierarchy.lock"),
    {},
    fn,
    (holder, path) =>
      new Error(
        `The task hierarchy is being changed by another boof process (pid ${holder}); try again in a moment, or remove ${path} if no boof process is running`,
      ),
  );
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
    childrenOf: (id) => [...(children.get(id) ?? [])],
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

/**
 * The tasks and, when `withEpics`, the epics. Epics are read only by the operations that look an
 * epic up: `EpicStore.list` throws on an unreadable `epics.json` by design, and a plain delete, a
 * move to a parent or a subtask create must not fail because of it.
 */
async function load(projectDir: string, withEpics: boolean) {
  const store = new TaskStore(projectDir);
  const epics = new EpicStore(projectDir);
  const tasks = await store.list();
  const all = withEpics ? await epics.list({ includeArchived: true }) : [];
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
    const { store, all, tasks } = await load(projectDir, epicId !== undefined);
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
    const { store, all, tasks, index } = await load(projectDir, typeof input.epicId === "string");
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
    const { store, tasks, index } = await load(projectDir, false);
    const task = tasks.find((t) => t.frontmatter.id === id);
    if (!task) throw new TaskNotFoundError(id);
    const kids = index.childrenOf(id);
    if (kids.length > 0 && !opts.detach) {
      throw bad(
        "has_children",
        `Task ${id} has ${kids.length} subtask(s); pass detach to keep them`,
      );
    }
    // Delete first, refusing a running task under its task lock: if the delete is refused nothing
    // has changed. The children then lose a parent that no longer exists, which is tolerated
    // (`parentMissing`) until the loop below detaches them.
    await store.delete(id, { refuseRunning: true });
    const detached: string[] = [];
    const epicId = task.frontmatter.epicId;
    for (const kid of kids) {
      const kidId = kid.frontmatter.id;
      // The child takes the parent's epic, or none: its own stale epicId must not resurface.
      const from = { epicId: kid.frontmatter.epicId, parentId: id };
      try {
        await store.modify(kidId, (t) => {
          delete t.frontmatter.parentId;
          if (epicId !== undefined) t.frontmatter.epicId = epicId;
          else delete t.frontmatter.epicId;
        });
      } catch (err) {
        if (err instanceof TaskNotFoundError) continue; // deleted since the scan
        throw err;
      }
      await moved(projectDir, kidId, from, { epicId }, opts.by);
      detached.push(kidId);
    }

    return { detached };
  });
}

/** Members detached per hold of the hierarchy lock by `removeEpic`. */
const DETACH_BATCH = 100;

/**
 * Remove an epic, with `detach` clearing the epic of its tasks first. The hierarchy lock is a pid
 * lock that others wait 30 s for, and each detached task is one fsynced write, so a big epic is
 * detached `batch` tasks per hold: other operations get in between. Every pass scans again, and
 * the pass that finds `batch` tasks or fewer detaches them and removes the epic record under the
 * same hold, so no task can join after the last scan and keep naming a removed epic.
 */
export async function removeEpic(
  projectDir: string,
  epicId: string,
  opts: { detach?: boolean; by?: string; batch?: number } = {},
): Promise<{ detached: string[] }> {
  const batch = Math.max(1, opts.batch ?? DETACH_BATCH);
  const detached: string[] = [];
  for (;;) {
    const finished = await withHierarchyLock(projectDir, async () => {
      const { store, epics, tasks, all } = await load(projectDir, true);
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
      for (const m of members.slice(0, batch)) {
        const tid = m.frontmatter.id;
        try {
          await store.modify(tid, (t) => {
            delete t.frontmatter.epicId;
          });
        } catch (err) {
          if (err instanceof TaskNotFoundError) continue; // deleted since the scan
          throw err;
        }
        await moved(
          projectDir,
          tid,
          { epicId, parentId: m.frontmatter.parentId },
          { parentId: m.frontmatter.parentId },
          opts.by,
        );
        detached.push(tid);
      }
      if (members.length > batch) return false;
      await epics.remove(epicId, { by: opts.by });
      return true;
    });
    if (finished) return { detached };
  }
}
