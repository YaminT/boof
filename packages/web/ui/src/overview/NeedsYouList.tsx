import { Button } from "@/ui/button";
import { api } from "../api.js";
import { act } from "../lib/act.js";
import { type Route } from "../lib/route.js";
import type { NeedsYouItem } from "../lib/task-groups.js";

/** What waits on the user: planner questions, proposed drafts and draft plans. */
export function NeedsYouList({
  pid,
  items,
  navigate,
  onChange,
}: {
  pid: string;
  items: NeedsYouItem[];
  navigate: (to: Route) => void;
  onChange: () => void;
}) {
  if (items.length === 0) {
    return <p className="m-0 text-[length:var(--text-row)] text-ink-muted">Nothing needs you.</p>;
  }
  const queue = (id: string) =>
    void act(() => api.updateTask(pid, id, { status: "pending" }), {
      success: "Queued",
      failure: "Could not queue",
    }).then(onChange);
  return (
    <ul className="m-0 list-none p-0">
      {items.map((item) => {
        const key =
          item.kind === "draft-plan"
            ? `plan-${item.plan.id}`
            : `${item.kind}-${item.task.frontmatter.id}`;
        const title = item.kind === "draft-plan" ? item.plan.title : item.task.frontmatter.title;
        const what =
          item.kind === "question"
            ? "Asks a question"
            : item.kind === "proposed"
              ? "Proposed task"
              : "Draft plan";
        const openTask = () =>
          item.kind !== "draft-plan" &&
          navigate({ name: "task", pid, taskId: item.task.frontmatter.id, view: "edit" });
        return (
          <li
            key={key}
            className="flex items-center gap-2 border-b border-line py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[length:var(--text-row)] font-medium">{title}</div>
              <div className="text-[length:var(--text-meta)] text-attention">{what}</div>
            </div>
            {item.kind === "question" && (
              <Button size="sm" onClick={() => navigate({ name: "inbox" })}>
                Answer
              </Button>
            )}
            {item.kind === "proposed" && (
              <>
                <Button size="sm" variant="outline" onClick={openTask}>
                  Open
                </Button>
                <Button size="sm" onClick={() => queue(item.task.frontmatter.id)}>
                  Queue
                </Button>
              </>
            )}
            {item.kind === "draft-plan" && (
              <Button
                size="sm"
                onClick={() => navigate({ name: "plans", pid, planId: item.plan.id })}
              >
                Open plan
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
