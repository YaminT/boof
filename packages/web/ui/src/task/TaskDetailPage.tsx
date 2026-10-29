import { useRef } from "react";
import { api } from "../api.js";
import { cn } from "@/lib/utils";
import { act } from "../lib/act.js";
import { stepHeaders } from "../lib/log-tail.js";
import { formatRoute, type Route, type TaskView as RouteView } from "../lib/route.js";
import { useElapsed } from "../overview/useElapsed.js";
import { useTaskActions } from "../tasks/useTaskActions.js";
import type { AppData } from "../useAppData.js";
import { ChangesTab } from "./ChangesTab.js";
import { QuestionsTab } from "./QuestionsTab.js";
import { RunTab } from "./RunTab.js";
import { StepStrip } from "./StepStrip.js";
import { TaskForm, type FormHandle } from "./TaskForm.js";
import { TaskHeader } from "./TaskHeader.js";
import { useTask } from "./useTask.js";

export const NEW_TASK = "__new__";

type Navigate = (to: Route, opts?: { replace?: boolean }) => void;

const TABS: { view: RouteView; label: string }[] = [
  { view: "edit", label: "Run" },
  { view: "changes", label: "Changes" },
  { view: "questions", label: "Questions" },
];

const BACK = new Set(["tasks", "overview"]);

function MissingTask({ href }: { href: string }) {
  return (
    <div className="py-8">
      <p className="mt-0 mb-3 text-ink-muted">This task no longer exists.</p>
      <a href={href} className="text-accent-brand hover:underline">
        Back to tasks
      </a>
    </div>
  );
}

/** The screen of one task, or of a new one (`taskId` is `__new__`). */
export function TaskDetailPage({
  pid,
  taskId,
  view,
  data,
  navigate,
  previous,
}: {
  pid: string;
  taskId: string;
  view: RouteView;
  data: AppData;
  navigate: Navigate;
  /** The route the user came from; "← Tasks" returns to it when it was Tasks or the Overview. */
  previous: Route | null;
}) {
  const tasksHref = formatRoute({ name: "tasks", pid });
  const backHref =
    previous && BACK.has(previous.name) && "pid" in previous && previous.pid === pid
      ? formatRoute(previous)
      : tasksHref;
  const open = (id: string, opts?: { replace?: boolean }) =>
    navigate({ name: "task", pid, taskId: id, view: "edit" }, opts);

  if (taskId === NEW_TASK) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <a
          href={backHref}
          className="w-fit text-[length:var(--text-row)] text-ink-muted no-underline hover:text-ink hover:underline"
        >
          ← Tasks
        </a>
        <h1 className="m-0 text-[length:var(--text-section)] font-semibold">New task</h1>
        <TaskForm
          pid={pid}
          task={null}
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
      tasksHref={tasksHref}
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
  tasksHref,
}: {
  pid: string;
  taskId: string;
  view: RouteView;
  data: AppData;
  navigate: Navigate;
  backHref: string;
  tasksHref: string;
}) {
  const row = data.tasks.find((t) => t.frontmatter.id === taskId);
  const { task, missing, reload } = useTask(pid, taskId, row?.frontmatter.updated ?? null);
  if (missing) return <MissingTask href={tasksHref} />;
  if (!task) return null;
  return (
    <Loaded
      pid={pid}
      task={task}
      view={view}
      data={data}
      navigate={navigate}
      backHref={backHref}
      reload={reload}
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
  reload,
}: {
  pid: string;
  task: NonNullable<ReturnType<typeof useTask>["task"]>;
  view: RouteView;
  data: AppData;
  navigate: Navigate;
  backHref: string;
  reload: () => Promise<void>;
}) {
  const id = task.frontmatter.id;
  const running = task.frontmatter.status === "running";
  const elapsed = useElapsed(pid, task, running);
  const actions = useTaskActions(pid, data, navigate);

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

  const remove = async () => {
    const ok = await act(() => api.deleteTask(pid, id), {
      success: "Deleted",
      failure: "Could not delete",
    });
    if (!ok) return;
    void data.refresh();
    navigate({ name: "tasks", pid });
  };

  return (
    <div className="flex flex-col gap-4">
      <TaskHeader
        task={task}
        backHref={backHref}
        elapsed={elapsed}
        actions={actions}
        onQueue={() => void queue()}
        onRetry={() => void retry()}
        onDelete={() => void remove()}
      />
      <StepStrip task={task} now={Date.now()} logHeaders={stepHeaders(task.body.log)} />
      <div className="grid items-start gap-6 min-[1024px]:grid-cols-[2fr_3fr]">
        <TaskForm
          pid={pid}
          task={task}
          locked={running}
          reload={reload}
          onCreated={() => {}}
          handle={form}
        />
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
          {view === "edit" && <RunTab pid={pid} task={task} reload={reload} />}
          {view === "changes" && <ChangesTab pid={pid} task={task} />}
          {view === "questions" && <QuestionsTab pid={pid} task={task} />}
        </section>
      </div>
    </div>
  );
}
