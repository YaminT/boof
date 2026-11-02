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

/** How many tasks name the epic themselves, which is what "delete and detach" would clear. */
export function epicTaskCount(tasks: TaskView[], epicId: string): number {
  return tasks.filter((t) => t.frontmatter.epicId === epicId).length;
}
