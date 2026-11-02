import { Button, buttonVariants } from "@/ui/button";
import { cn } from "@/lib/utils";
import type { TaskView } from "../api.js";
import { formatRoute } from "../lib/route.js";
import { childTasks, hierarchyLine, newSubtaskHref, tasksForEpicHref } from "../lib/task-links.js";
import { progressLabel } from "../lib/task-hierarchy.js";
import { StatusPill } from "../shell/StatusPill.js";
import { useEpics } from "../tasks/useEpics.js";
import type { TaskActions } from "../tasks/useTaskActions.js";

const link = "text-ink underline-offset-2 hover:underline";
const taskHref = (pid: string, taskId: string) =>
  formatRoute({ name: "task", pid, taskId, view: "edit" });

/**
 * Where the task sits (its epic and parent, with a way out when either no longer exists) and, for
 * a top-level task, its subtasks with an Add subtask link. A subtask has no subtasks of its own.
 */
export function TaskHierarchy({
  pid,
  task,
  tasks,
  actions,
}: {
  pid: string;
  task: TaskView;
  tasks: TaskView[];
  actions: TaskActions;
}) {
  const epics = useEpics(pid, tasks);
  const f = task.frontmatter;
  const line = hierarchyLine(task, epics, tasks);
  const kids = childTasks(tasks, f.id);
  const canAdd = !f.parentId && f.status !== "archived";
  const showSubtasks = kids.items.length > 0 || canAdd;
  if (!line.epic && !line.parent && !showSubtasks) return null;

  return (
    <section aria-label="Hierarchy" className="flex flex-col gap-3">
      {(line.parent || line.epic) && (
        <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-2 text-[length:var(--text-row)] text-ink-muted">
          {line.parent &&
            (line.parent.missing ? (
              <span className="flex flex-wrap items-center gap-2 text-attention">
                Its parent task “{line.parent.id}” no longer exists.
                <Button size="sm" variant="outline" onClick={() => actions.detachParent(f.id)}>
                  Detach from the parent
                </Button>
              </span>
            ) : (
              <span>
                Subtask of{" "}
                <a href={taskHref(pid, line.parent.id)} className={link}>
                  {line.parent.title}
                </a>
              </span>
            ))}
          {line.epic &&
            (line.epic.missing ? (
              <span className="flex flex-wrap items-center gap-2 text-attention">
                Its epic “{line.epic.id}” no longer exists
                {line.epic.inherited ? " (it comes from the parent task)." : "."}
                {!line.epic.inherited && (
                  <Button size="sm" variant="outline" onClick={() => actions.detachEpic(f.id)}>
                    Clear the epic
                  </Button>
                )}
              </span>
            ) : (
              <span>
                Epic{" "}
                <a href={tasksForEpicHref(pid, line.epic.id)} className={link}>
                  {line.epic.title}
                </a>
                {line.epic.inherited && " (from the parent task)"}
              </span>
            ))}
        </p>
      )}
      {showSubtasks && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="m-0 text-[length:var(--text-body)] font-semibold">Subtasks</h2>
            {kids.progress && (
              <span className="text-[length:var(--text-row)] text-ink-muted tabular-nums">
                {progressLabel(kids.progress)} done
              </span>
            )}
            {canAdd && (
              <a
                href={newSubtaskHref(pid, f.id)}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "ml-auto no-underline",
                )}
              >
                Add subtask
              </a>
            )}
          </div>
          {kids.items.length > 0 && (
            <ul className="m-0 list-none p-0">
              {kids.items.map((c) => (
                <li
                  key={c.frontmatter.id}
                  className="flex min-h-9 items-center gap-3 border-b border-line py-1 text-[length:var(--text-row)] last:border-b-0"
                >
                  <a
                    href={taskHref(pid, c.frontmatter.id)}
                    className={`${link} min-w-0 flex-1 truncate font-medium no-underline`}
                  >
                    {c.frontmatter.title}
                  </a>
                  <StatusPill status={c.frontmatter.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
