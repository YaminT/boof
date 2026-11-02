import { buildHierarchyIndex, type Epic, type Task } from "@boof-runner/shared";

const MAX_LISTED = 50;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function bullets(tasks: Task[]): string[] {
  const lines = tasks
    .slice(0, MAX_LISTED)
    .map(
      (t) => `- \`${t.frontmatter.id}\` ${oneLine(t.frontmatter.title)} (${t.frontmatter.status})`,
    );
  if (tasks.length > MAX_LISTED) lines.push(`- … and ${tasks.length - MAX_LISTED} more`);
  return lines;
}

/**
 * The `## Hierarchy` section of a task's prompt: its epic, its parent and siblings, or its
 * subtasks, as titles and statuses only. Drafts are left out, and so are archived tasks: a draft
 * may be text no human has approved yet (a review-trust client's proposal), and it must not reach
 * an agent working on a task a human did approve. Null when there is nothing to say.
 */
export function hierarchyPromptSection(task: Task, tasks: Task[], epics: Epic[]): string | null {
  const index = buildHierarchyIndex(tasks, epics);
  const shown = (t: Task) =>
    t.frontmatter.status !== "draft" && t.frontmatter.status !== "archived";
  const lines: string[] = [];

  const epicId = index.info(task).epicId;
  const epic = epicId === undefined ? undefined : epics.find((e) => e.id === epicId);
  // The title of an epic a client created is client text no human approved (it can be renamed after
  // the work was approved), so only its id, which is kebab-case, is printed.
  if (epic) lines.push(`Epic: ${epic.origin?.client ? clip(epic.id, 64) : oneLine(epic.title)}`);

  const parentId = task.frontmatter.parentId;
  const parent =
    parentId === undefined ? undefined : tasks.find((t) => t.frontmatter.id === parentId);
  if (parent && shown(parent)) {
    lines.push(
      `This task is a subtask of \`${parent.frontmatter.id}\` "${oneLine(parent.frontmatter.title)}" (${parent.frontmatter.status}).`,
    );
    const siblings = index
      .childrenOf(parent.frontmatter.id)
      .filter((t) => t.frontmatter.id !== task.frontmatter.id && shown(t));
    if (siblings.length > 0) {
      lines.push(
        "Other subtasks of that task (titles and status only; they run separately):",
        ...bullets(siblings),
      );
    }
  }

  const children = index.childrenOf(task.frontmatter.id).filter(shown);
  if (children.length > 0) {
    lines.push(
      "This task has subtasks that run separately (titles and status only):",
      ...bullets(children),
    );
  }

  return lines.length > 0 ? `## Hierarchy\n${lines.join("\n")}` : null;
}
