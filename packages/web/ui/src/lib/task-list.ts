import type { TaskView } from "../api.js";
import { groupTasks } from "./task-groups.js";

export interface TaskFilter {
  query: string;
  state: "all" | "needs-you" | "running" | "queued" | "drafts" | "finished";
  label: string | null;
}

const FINISHED = new Set(["done", "failed", "stopped", "archived"]);

export function filterTasks(tasks: TaskView[], f: TaskFilter): TaskView[] {
  const q = f.query.trim().toLowerCase();
  const g = groupTasks(tasks);
  const needsYou = new Set(
    g.needsYou.flatMap((i) => (i.kind === "draft-plan" ? [] : [i.task.frontmatter.id])),
  );
  const drafts = new Set(g.drafts.map((t) => t.frontmatter.id));

  const inState = (t: TaskView): boolean => {
    const { id, status } = t.frontmatter;
    switch (f.state) {
      case "all":
        return true;
      case "needs-you":
        return needsYou.has(id);
      case "running":
        return status === "running";
      case "queued":
        return status === "pending";
      case "drafts":
        return drafts.has(id);
      case "finished":
        return FINISHED.has(status);
    }
  };

  return tasks.filter((t) => {
    const { id, title, labels } = t.frontmatter;
    if (q && !title.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) return false;
    if (f.label !== null && !labels.includes(f.label)) return false;
    return inState(t);
  });
}

export function allLabels(tasks: TaskView[]): string[] {
  return [...new Set(tasks.flatMap((t) => t.frontmatter.labels))].sort();
}

export type ListKeyAction =
  "down" | "up" | "open" | "queue" | "stop" | "move-up" | "move-down" | null;

export function listKeyAction(
  e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  typingTarget: boolean,
  dialogOpen: boolean,
): ListKeyAction {
  if (typingTarget || dialogOpen || e.ctrlKey || e.metaKey) return null;
  if (e.altKey) {
    if (e.shiftKey) return null;
    return e.key === "ArrowUp" ? "move-up" : e.key === "ArrowDown" ? "move-down" : null;
  }
  if (e.shiftKey) return null;
  switch (e.key) {
    case "j":
      return "down";
    case "k":
      return "up";
    case "Enter":
      return "open";
    case "q":
      return "queue";
    case "s":
      return "stop";
    default:
      return null;
  }
}

export function moveQueued(order: string[], id: string, delta: -1 | 1): string[] | null {
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return null;
  const out = [...order];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
