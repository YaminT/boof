import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Project } from "@boof/heart/schema";
import { api } from "../api.js";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { act } from "../lib/act.js";
import { stepHeaders } from "../lib/log-tail.js";
import { FocusToggle } from "@/ui/focus-toggle";
import { taskFormOpen } from "../lib/focus-views.js";
import { useFocusMode } from "../lib/useFocusMode.js";
import { hasChildrenConflict, serverSubtaskCount } from "../lib/task-delete.js";
import { childTasks, parentFromSearch } from "../lib/task-links.js";
import { backFor, formatRoute, type Route, type TaskView as RouteView } from "../lib/route.js";
import { useElapsed } from "../overview/useElapsed.js";
import { useTaskActions } from "../tasks/useTaskActions.js";
import type { AppData } from "../useAppData.js";
const ChangesTab = lazy(() => import("./ChangesTab.js").then((m) => ({ default: m.ChangesTab })));
import { QuestionsTab } from "./QuestionsTab.js";
import { RunTab } from "./RunTab.js";
import { StepStrip } from "./StepStrip.js";
import { TaskHierarchy } from "./TaskHierarchy.js";
import { TaskForm, type FormHandle } from "./TaskForm.js";
import { SandboxFailure } from "./SandboxFailure.js";
import { TaskHeader } from "./TaskHeader.js";
import { useTask } from "./useTask.js";

export const NEW_TASK = "__new__";

type Navigate = (to: Route, opts?: { replace?: boolean }) => void;

const TABS: { view: RouteView; label: string }[] = [
  { view: "edit", label: "Run" },
  { view: "changes", label: "Changes" },
  { view: "questions", label: "Questions" },
];

/** The screen of one task, or of a new one (`taskId` is `__new__`). */
export function TaskDetailPage({
  pid,
  taskId,
  view,
  data,
  navigate,
  previous,
  project = null,
}: {
  /** The selected project (its own role choices decide which tool runs a step). */
  project?: Project | null;
  pid: string;
  taskId: string;
  view: RouteView;
  data: AppData;
  navigate: Navigate;
  /** The route the user came from; the back link returns to it (a plan, Tasks or the Overview). */
  previous: Route | null;
}) {
  const back = backFor(previous, pid);
  const backHref = formatRoute(back.route);
  const open = (id: string, opts?: { replace?: boolean }) =>
    navigate({ name: "task", pid, taskId: id, view: "edit" }, opts);

  if (taskId === NEW_TASK) {
    // The "Add subtask" link on a task page: /p/<pid>/tasks/__new__?parent=<id>.
    const parentId = parentFromSearch(window.location.search);
    const parent = parentId ? data.tasks.find((t) => t.frontmatter.id === parentId) : undefined;
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <a
          href={backHref}
          className="w-fit text-[length:var(--text-row)] text-ink-muted no-underline hover:text-ink hover:underline"
        >
          {back.label}
        </a>
        <h1 className="m-0 text-[length:var(--text-section)] font-semibold">
          {parentId ? "New subtask" : "New task"}
        </h1>
        {parentId && (
          <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
            Subtask of{" "}
            <a
              href={formatRoute({ name: "task", pid, taskId: parentId, view: "edit" })}
              className="text-ink hover:underline"
            >
              {parent?.frontmatter.title ?? parentId}
            </a>
            . It takes the parent's epic.
          </p>
        )}
        <TaskForm
          pid={pid}
          task={null}
          parentId={parentId ?? undefined}
          locked={false}
          reload={async () => {}}
          onCreated={(id) => {
            void data.refresh();
            open(id, { replace: true });
          }}
        />
      </div>
    );
  }
  return (
    <ExistingTask
      pid={pid}
      taskId={taskId}
      view={view}
      data={data}
      navigate={navigate}
      backHref={backHref}
      backLabel={back.label}
      project={project}
    />
  );
}

function ExistingTask({
  pid,
  taskId,
  view,
  data,
  navigate,
  backHref,
  backLabel,
  project,
}: {
  pid: string;
  taskId: string;
  view: RouteView;
  data: AppData;
  navigate: Navigate;
  backHref: string;
  backLabel: string;
  project: Project | null;
}) {
  const row = data.tasks.find((t) => t.frontmatter.id === taskId);
  const listKey = row
    ? `${row.frontmatter.updated}|${row.frontmatter.steps?.length ?? 0}|${row.frontmatter.status}|${row.body.injected.length}`
    : null;
  const { task, missing, failed, reload } = useTask(pid, taskId, listKey);
  // A deleted or unknown task: leave its dead URL for the list, replacing it so Back skips it.
  useEffect(() => {
    if (!missing) return;
    toast("This task no longer exists.");
    navigate({ name: "tasks", pid }, { replace: true });
  }, [missing, navigate, pid]);
  if (missing) return null;
  if (!task) {
    return failed ? (
      <div className="py-8">
        <p className="mt-0 mb-3 text-ink-muted">Could not load this task.</p>
        <Button variant="outline" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    ) : null;
  }
  return (
    <Loaded
      pid={pid}
      task={task}
      view={view}
      data={data}
      navigate={navigate}
      backHref={backHref}
      backLabel={backLabel}
      reload={reload}
      project={project}
    />
  );
}

function Loaded({
  pid,
  task,
  view,
  data,
  navigate,
  backHref,
  backLabel,
  reload,
  project,
}: {
  project: Project | null;
  pid: string;
  task: NonNullable<ReturnType<typeof useTask>["task"]>;
  view: RouteView;
  data: AppData;
  navigate: Navigate;
  backHref: string;
  backLabel: string;
  reload: () => Promise<void>;
}) {
  const id = task.frontmatter.id;
  const running = task.frontmatter.status === "running";
  const elapsed = useElapsed(pid, task, running);
  const actions = useTaskActions(pid, data, navigate);
  const focus = useFocusMode("task-detail");
  const [disclosed, setDisclosed] = useState(false);
  const [attention, setAttention] = useState(false);
  const formOpen = taskFormOpen(focus.expanded, disclosed, attention);

  // Queue and Retry must carry unsaved edits, or they would run what the form no longer shows.
  const form = useRef<FormHandle | null>(null);
  const queue = async () => {
    if (form.current?.dirty) {
      if (await form.current.save("pending")) await data.refresh();
    } else actions.queue(id);
  };
  const retry = async () => {
    if (form.current?.dirty && !(await form.current.save())) return;
    actions.retry(id);
  };

  const remove = async (
    detach: boolean,
  ): Promise<"deleted" | "failed" | { needsDetach: number | null }> => {
    let refused: { count: number | null } | null = null;
    const ok = await act(() => api.deleteTask(pid, id, detach), {
      success: "Deleted",
      failure: "Could not delete",
      // Subtasks the list did not show yet: not an error, but a second question for the user.
      onError: (err) => {
        if (detach || !hasChildrenConflict(err)) return false;
        refused = { count: serverSubtaskCount(err) };
        return true;
      },
    });
    if (refused) return { needsDetach: (refused as { count: number | null }).count };
    if (!ok) return "failed";
    void data.refresh();
    navigate({ name: "tasks", pid }, { replace: true });
    return "deleted";
  };

  return (
    <div className="flex flex-col gap-4">
      <TaskHeader
        task={task}
        backHref={backHref}
        backLabel={backLabel}
        elapsed={elapsed}
        actions={actions}
        onQueue={() => void queue()}
        onRetry={() => void retry()}
        subtasks={childTasks(data.tasks, id).items.length}
        onDelete={remove}
      />
      <SandboxFailure pid={pid} status={task.frontmatter.status} log={task.body.log} />
      <TaskHierarchy
        pid={pid}
        task={task}
        tasks={data.tasks}
        actions={actions}
        planTick={data.planTick}
      />
      <StepStrip task={task} now={Date.now()} logHeaders={stepHeaders(task.body.log)} />
      <div className="flex flex-wrap items-center gap-3">
        {!focus.expanded && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={formOpen}
            aria-controls="task-form-region"
            aria-disabled={attention || undefined}
            title={attention ? "Open because it has unsaved changes" : undefined}
            onClick={() => !attention && setDisclosed(!disclosed)}
          >
            {formOpen ? "Hide task details" : "Edit task details"}
          </Button>
        )}
        {attention && !focus.expanded && (
          <span className="text-[length:var(--text-meta)] text-attention">
            Task details stay open while they have unsaved changes.
          </span>
        )}
        <FocusToggle mode={focus.mode} onToggle={focus.toggle} className="ml-auto" />
      </div>
      <div className={cn("grid items-start gap-6", formOpen && "min-[1024px]:grid-cols-[2fr_3fr]")}>
        <div id="task-form-region" hidden={!formOpen}>
          <TaskForm
            pid={pid}
            task={task}
            locked={running}
            reload={reload}
            onCreated={() => {}}
            handle={form}
            onAttention={setAttention}
          />
        </div>
        <section className="min-w-0">
          <nav aria-label="Task view" className="mb-3 flex gap-1 border-b border-line">
            {TABS.map((t) => (
              <a
                key={t.view}
                href={formatRoute({ name: "task", pid, taskId: id, view: t.view })}
                aria-current={view === t.view ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 no-underline py-2 text-[length:var(--text-body)] font-medium",
                  view === t.view
                    ? "border-accent-brand text-ink"
                    : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {t.label}
              </a>
            ))}
          </nav>
          {view === "edit" && (
            <RunTab
              pid={pid}
              task={task}
              reload={reload}
              settings={data.settings}
              project={project}
            />
          )}
          {view === "changes" && (
            <Suspense fallback={null}>
              <ChangesTab pid={pid} task={task} />
            </Suspense>
          )}
          {view === "questions" && <QuestionsTab pid={pid} task={task} reload={reload} />}
        </section>
      </div>
    </div>
  );
}
