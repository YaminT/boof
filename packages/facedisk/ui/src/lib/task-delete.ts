import { ApiError } from "../api.js";

/** The warning every task deletion shows; the assistant's confirm dialog reuses it word for word. */
export const DELETE_TASK_WARNING =
  "Delete this task? Its file, reports and log are removed. This cannot be undone.";

export interface DeleteDialogModel {
  /** Send `detach: true`: the user has agreed that the subtasks become top-level tasks. */
  detach: boolean;
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * What the delete confirmation says. A task with subtasks (or one the server refused for having
 * some) is only deleted with an explicit choice to detach them; nothing is deleted in cascade.
 */
export function deleteDialogModel(subtasks: number, refused: boolean): DeleteDialogModel {
  if (subtasks === 0 && !refused) {
    return {
      detach: false,
      title: "Delete task",
      body: DELETE_TASK_WARNING,
      confirmLabel: "Delete task",
    };
  }
  const what =
    subtasks > 0
      ? `This task has ${subtasks} ${subtasks === 1 ? "subtask" : "subtasks"}.`
      : "This task has subtasks.";
  return {
    detach: true,
    title: "Delete task with subtasks",
    body: `${what} If you delete it they become top-level tasks and keep their own files and logs; they are not deleted. The task's own file, reports and log are removed. This cannot be undone.`,
    confirmLabel: "Delete and detach subtasks",
  };
}

/** The 409 for deleting a task that still has subtasks (without `detach`). */
export function hasChildrenConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === "has_children";
}

/** The subtask count the server's refusal names ("has 3 subtask(s)"), if it says one. */
export function serverSubtaskCount(err: unknown): number | null {
  if (!(err instanceof ApiError)) return null;
  const m = /\bhas (\d+) subtask/.exec(err.message);
  return m ? Number(m[1]) : null;
}

/** The count to show: what the server said, or at least what the page knows. */
export function shownSubtasks(known: number, fromServer: number | null): number {
  return Math.max(known, fromServer ?? 0);
}

/** How long a destructive "delete and detach" stays disabled after it appears. */
export const DETACH_ARM_MS = 500;
