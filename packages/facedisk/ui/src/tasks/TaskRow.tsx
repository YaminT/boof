import type { CSSProperties, ReactNode, Ref } from "react";
import type { EpicView, Plan, PlanSummary, TaskView } from "../api.js";
import { planChip } from "../lib/plan-grouping.js";
import { progressLabel, type HierarchyRow } from "../lib/task-hierarchy.js";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "../lib/run-timing.js";
import { stopDisabled, useStopRequested } from "../lib/stop-request.js";
import { StatusPill } from "../shell/StatusPill.js";
import { useElapsed } from "../overview/useElapsed.js";
import { TaskRowMenu } from "./TaskRowMenu.js";
import type { TaskActions } from "./useTaskActions.js";

export type RowEntry =
  | {
      key: string;
      kind: "question" | "proposed" | "draft" | "running" | "finished";
      task: TaskView;
      hier?: HierarchyRow;
    }
  /** `pos` is the queue number, or null for a skipped task. */
  | { key: string; kind: "queued"; task: TaskView; pos: number | null; hier?: HierarchyRow }
  | { key: string; kind: "plan"; plan: PlanSummary };

export interface RowContext {
  pid: string;
  actions: TaskActions;
  selectedKey: string | null;
  /** The one row in the tab order: the selected row, else the first. */
  tabbableKey: string | null;
  onSelect: (key: string) => void;
  onStop: (id: string) => void;
  /** The project's epics by id, to name the epic chips. */
  epics: ReadonlyMap<string, EpicView>;
  /** The project's plans by id and the loaded ones with their goals, to name the plan chips. */
  plans: ReadonlyMap<string, PlanSummary>;
  planDetails: ReadonlyMap<string, Plan>;
}

function RunningMarker({ pid, task }: { pid: string; task: TaskView }) {
  const elapsed = useElapsed(pid, task, true);
  return (
    <span className="inline-flex items-center gap-1.5 text-running">
      <span className="size-1.5 rounded-full bg-running motion-safe:animate-pulse" />
      {elapsed !== null ? formatDuration(elapsed) : "running"}
    </span>
  );
}

function Marker({ entry, pid }: { entry: RowEntry; pid: string }): ReactNode {
  switch (entry.kind) {
    case "question":
      return <span className="text-attention">question</span>;
    case "plan":
      return <span className="text-attention">plan</span>;
    case "proposed":
      return <span className="text-attention">proposed</span>;
    case "running":
      return <RunningMarker pid={pid} task={entry.task} />;
    case "queued":
      return entry.pos === null ? (
        <span className="text-ink-muted">skipped</span>
      ) : (
        <span className="block w-full text-right tabular-nums text-ink-muted">{entry.pos}</span>
      );
    case "draft":
      return <span className="text-ink-muted">draft</span>;
    case "finished":
      return <StatusPill status={entry.task.frontmatter.status} />;
  }
}

function primary(entry: RowEntry, ctx: RowContext): { label: string; run: () => void } | null {
  const { actions, onStop } = ctx;
  switch (entry.kind) {
    case "question":
      return { label: "Answer", run: () => actions.answer(entry.task.frontmatter.id) };
    case "plan":
      return { label: "Open plan", run: () => actions.openPlan(entry.plan.id) };
    case "proposed":
    case "draft":
      return { label: "Queue", run: () => actions.queue(entry.task.frontmatter.id) };
    case "running":
      return { label: "Stop", run: () => onStop(entry.task.frontmatter.id) };
    case "queued":
      return { label: "Edit", run: () => actions.open(entry.task.frontmatter.id) };
    case "finished": {
      const { id, status } = entry.task.frontmatter;
      if (status === "done") return { label: "Open changes", run: () => actions.openChanges(id) };
      if (status === "failed" || status === "stopped")
        return { label: "Retry", run: () => actions.retry(id) };
      return null;
    }
  }
}

const chip = "shrink-0 rounded border border-line px-1 text-[length:var(--text-meta)]";

/** Epic, subtask progress, parent and missing-reference chips after the title. */
function HierarchyChips({
  task,
  hier,
  ctx,
}: {
  task: TaskView;
  hier: HierarchyRow | undefined;
  ctx: RowContext;
}) {
  const plan = planChip(ctx.pid, task, ctx.plans, ctx.planDetails);
  const epic = task.epicId ? (ctx.epics.get(task.epicId)?.title ?? task.epicId) : null;
  return (
    <>
      {hier?.progress && (
        <span
          className={cn(chip, "tabular-nums text-ink-muted")}
          title={`${hier.progress.done} of ${hier.progress.total} subtasks done`}
        >
          {progressLabel(hier.progress)}
        </span>
      )}
      {hier?.parentRef && (
        <button
          type="button"
          onClick={() => ctx.actions.open(hier.parentRef!.id)}
          title={`Subtask of ${hier.parentRef.title}`}
          className={cn(
            "focus-ring",
            chip,
            "hidden max-w-40 truncate bg-transparent text-ink-muted hover:underline min-[720px]:block",
          )}
        >
          ↳ {hier.parentRef.title}
        </button>
      )}
      {plan && (
        <a
          href={plan.href}
          title={plan.label}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "focus-ring",
            chip,
            "hidden max-w-56 truncate text-ink-muted no-underline hover:underline min-[720px]:block",
          )}
        >
          {plan.label}
        </a>
      )}
      {epic && !task.epicMissing && (
        <span
          className={cn(chip, "hidden max-w-32 truncate text-ink-muted min-[720px]:block")}
          title={`Epic: ${epic}`}
        >
          {epic}
        </span>
      )}
      {task.parentMissing && (
        <span
          className={cn(chip, "border-attention text-attention")}
          title="This task names a parent that no longer exists, so it is listed on its own. Detach it from the row menu."
        >
          parent missing
        </span>
      )}
      {task.epicMissing && (
        <span
          className={cn(chip, "border-attention text-attention")}
          title={`The epic ${task.epicId ?? ""} does not exist. ${
            task.frontmatter.epicId
              ? "Clear it from the row menu."
              : "It comes from the parent task."
          }`}
        >
          epic missing
        </span>
      )}
    </>
  );
}

/** One 40 px row: marker, title, metadata, one primary action and the overflow menu. */
export function TaskRow({
  entry,
  ctx,
  handle,
  rowRef,
  style,
}: {
  entry: RowEntry;
  ctx: RowContext;
  /** The drag handle of a queued row; other rows get an empty slot of the same width. */
  handle?: ReactNode;
  rowRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
}) {
  const { pid, actions, selectedKey, onSelect } = ctx;
  const selected = selectedKey === entry.key;
  const task = entry.kind === "plan" ? null : entry.task;
  const title = entry.kind === "plan" ? entry.plan.title : entry.task.frontmatter.title;
  const open = () =>
    entry.kind === "plan"
      ? actions.openPlan(entry.plan.id)
      : actions.open(entry.task.frontmatter.id);
  const action = primary(entry, ctx);
  const f = task?.frontmatter;
  const stopRequested = useStopRequested(pid, task?.frontmatter.id ?? "");
  const hier = entry.kind === "plan" ? undefined : entry.hier;
  return (
    <li
      ref={rowRef}
      style={style}
      data-row-key={entry.key}
      aria-current={selected || undefined}
      tabIndex={ctx.tabbableKey === entry.key ? 0 : -1}
      onFocus={() => onSelect(entry.key)}
      onClick={() => onSelect(entry.key)}
      className={cn(
        "flex h-10 items-center gap-2 border-b border-line px-1 text-[length:var(--text-row)] last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        selected && "bg-accent outline-2 -outline-offset-2 outline-accent-brand",
      )}
    >
      <span className="flex w-4 shrink-0 min-[720px]:w-5 justify-center">{handle}</span>
      <span className="w-14 shrink-0 truncate min-[720px]:w-20">
        <Marker entry={entry} pid={pid} />
      </span>
      <button
        type="button"
        onClick={open}
        className={cn(
          "min-w-[4rem] flex-1 truncate bg-transparent p-0 min-[720px]:min-w-[8rem] text-left text-[length:inherit] font-medium text-ink hover:underline",
          hier?.child && "ml-4",
        )}
      >
        {hier?.child && (
          <span aria-hidden className="mr-1 text-ink-muted">
            ↳
          </span>
        )}
        {title}
      </button>
      {task && <HierarchyChips task={task} hier={hier} ctx={ctx} />}
      {f && (
        <span className="hidden w-auto max-w-52 shrink items-center gap-1.5 truncate text-[length:var(--text-meta)] text-ink-muted min-[1100px]:flex">
          <span>p{f.priority}</span>
          {f.labels.map((l) => (
            <span key={l} className="rounded border border-line px-1">
              {l}
            </span>
          ))}
        </span>
      )}
      <span className="flex shrink-0 justify-end min-[720px]:w-24">
        {action && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              entry.kind === "running" && stopDisabled(entry.task.frontmatter.status, stopRequested)
            }
            onClick={action.run}
          >
            {action.label}
          </Button>
        )}
      </span>
      <span className="flex size-7 shrink-0 justify-center">
        {task && <TaskRowMenu task={task} queued={entry.kind === "queued"} actions={actions} />}
      </span>
    </li>
  );
}
