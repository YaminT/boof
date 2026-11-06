import { ApiError, type TaskView } from "../api.js";

export type EpicFormResult =
  { ok: true; value: { title: string; priority: number } } | { ok: false; problems: string[] };

/** The epic form's fields as the API wants them; an empty priority is 0. */
export function parseEpicForm(f: { title: string; priority: string }): EpicFormResult {
  const problems: string[] = [];
  const title = f.title.trim();
  if (!title) problems.push("Name the epic.");
  else if (title.length > 200) problems.push("The name is at most 200 characters.");
  const p = f.priority.trim();
  const priority = p === "" ? 0 : /^-?\d+$/.test(p) ? Number(p) : NaN;
  if (!Number.isSafeInteger(priority)) problems.push("Priority is a whole number.");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { title, priority } };
}

/** The refusal to delete an epic that tasks still name: the user must choose detach or archive. */
export function needsDetach(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === "has_tasks";
}

/** Who uses an epic: the tasks that name it, and the subtasks that take it from their parent. */
export function epicUsage(tasks: TaskView[], epicId: string): { tasks: number; subtasks: number } {
  const direct = tasks.filter((t) => t.frontmatter.epicId === epicId).length;
  const inherited = tasks.filter((t) => t.epicId === epicId && t.frontmatter.parentId).length;
  return { tasks: direct, subtasks: inherited };
}

const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The sentence the delete-with-detach choice opens with: everyone who would lose the epic. */
export function epicDetachNote(title: string, u: { tasks: number; subtasks: number }): string {
  const single = u.tasks === 1 && u.subtasks === 0;
  const who =
    u.subtasks > 0
      ? `${n(u.tasks, "task")} and ${u.tasks === 1 ? "its" : "their"} ${n(u.subtasks, "subtask")}`
      : n(u.tasks, "task");
  return `${who} ${single ? "uses" : "use"} \u201c${title}\u201d. Archive it to keep the grouping, or delete it: that clears the epic on ${single ? "that task" : "them"}, and nothing else changes.`;
}
