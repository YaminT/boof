import type { TaskView } from "../api.js";
import type { NeedsYouItem } from "./task-groups.js";

export interface InboxGroup {
  pid: string;
  name: string;
  items: NeedsYouItem[];
}

const byCreated = (a: TaskView, b: TaskView) =>
  a.frontmatter.created < b.frontmatter.created
    ? -1
    : a.frontmatter.created > b.frontmatter.created
      ? 1
      : 0;

/**
 * What needs the user, per project. Questions come from every project (`actions`, oldest first);
 * the selected project adds its proposed tasks and draft plans. Its own questions are read from
 * `actions` too, so the `question` items of `selected.needsYou` are ignored and nothing shows twice.
 */
export function inboxGroups(
  actions: TaskView[],
  selected: { pid: string; needsYou: NeedsYouItem[] } | null,
  projects: { id: string; name: string }[],
): InboxGroup[] {
  const nameOf = (pid: string) => projects.find((p) => p.id === pid)?.name ?? pid;
  const byProject = new Map<string, NeedsYouItem[]>();
  for (const t of [...actions].sort(byCreated)) {
    const list = byProject.get(t.projectId) ?? [];
    list.push({ kind: "question", task: t });
    byProject.set(t.projectId, list);
  }
  if (selected) {
    const rest = selected.needsYou.filter((i) => i.kind !== "question");
    if (rest.length > 0)
      byProject.set(selected.pid, [...(byProject.get(selected.pid) ?? []), ...rest]);
  }
  return [...byProject.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([pid, items]) => ({ pid, name: nameOf(pid), items }))
    .sort((a, b) => {
      if (selected && a.pid !== b.pid) {
        if (a.pid === selected.pid) return -1;
        if (b.pid === selected.pid) return 1;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

export function inboxCount(groups: InboxGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}
