import type { EpicView, TaskView } from "../api.js";
import { formatRoute } from "./route.js";

const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const NONE = "none";

/** App-relative link to a project's Tasks list showing one epic (`none`: tasks without an epic). */
export function tasksForEpicHref(pid: string, epicId: string): string {
  return `${formatRoute({ name: "tasks", pid })}?epic=${encodeURIComponent(epicId)}`;
}

/** App-relative link to the new-task form for a subtask of `parentId`. */
export function newSubtaskHref(pid: string, parentId: string): string {
  return `${formatRoute({ name: "task", pid, taskId: "__new__", view: "edit" })}?parent=${encodeURIComponent(parentId)}`;
}

function param(search: string, key: string, allowNone: boolean): string | null {
  const v = new URLSearchParams(search).get(key);
  if (v === null) return null;
  if (allowNone && v === NONE) return NONE;
  return ID.test(v) ? v : null;
}

/** The epic filter in a Tasks URL's query, if it is a valid epic id or `none`. */
export const epicFromSearch = (search: string) => param(search, "epic", true);

/** The parent in a new-task URL's query, if it is a valid task id. */
export const parentFromSearch = (search: string) => param(search, "parent", false);

/** A task's subtasks (all states) and how many of the non-archived ones are done. */
export function childTasks(
  tasks: TaskView[],
  parentId: string,
): { items: TaskView[]; progress: { done: number; total: number } | null } {
  const items = tasks.filter((t) => t.frontmatter.parentId === parentId);
  const live = items.filter((t) => t.frontmatter.status !== "archived");
  return {
    items,
    progress:
      live.length > 0
        ? { done: live.filter((t) => t.frontmatter.status === "done").length, total: live.length }
        : null,
  };
}

export interface HierarchyLine {
  epic: { id: string; title: string; missing: boolean; inherited: boolean } | null;
  parent: { id: string; title: string; missing: boolean } | null;
}

/** What the task page says about where a task sits: its epic and its parent, dangling or not. */
export function hierarchyLine(
  task: TaskView,
  epics: ReadonlyMap<string, EpicView>,
  all: TaskView[],
): HierarchyLine {
  const f = task.frontmatter;
  const epic = task.epicId
    ? {
        id: task.epicId,
        title: epics.get(task.epicId)?.title ?? task.epicId,
        missing: task.epicMissing === true,
        inherited: f.epicId === undefined,
      }
    : null;
  const parent = f.parentId
    ? {
        id: f.parentId,
        title: all.find((t) => t.frontmatter.id === f.parentId)?.frontmatter.title ?? f.parentId,
        missing: task.parentMissing === true,
      }
    : null;
  return { epic, parent };
}

/** The current path and query with `key` set (or removed when null); other query keys stay. */
export function withQuery(
  pathname: string,
  search: string,
  key: string,
  value: string | null,
): string {
  const q = new URLSearchParams(search);
  if (value === null) q.delete(key);
  else q.set(key, value);
  const text = q.toString();
  return text ? `${pathname}?${text}` : pathname;
}

/** The current path and query with `epic` set (or removed when null). */
export const withEpicQuery = (pathname: string, search: string, epic: string | null) =>
  withQuery(pathname, search, "epic", epic);

/** `?manage=epics` on the Tasks URL opens the Manage epics sheet (the palette's "New epic"). */
export const manageEpicsFromSearch = (search: string): boolean =>
  new URLSearchParams(search).get("manage") === "epics";
