import type { CSSProperties, ReactNode, Ref } from "react";
import type { PlanSummary, TaskView } from "../api.js";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "../lib/run-timing.js";
import { StatusPill } from "../shell/StatusPill.js";
import { useElapsed } from "../overview/useElapsed.js";
import { TaskRowMenu } from "./TaskRowMenu.js";
import type { TaskActions } from "./useTaskActions.js";

export type RowEntry =
  | {
      key: string;
      kind: "question" | "proposed" | "draft" | "running" | "finished";
      task: TaskView;
    }
  /** `pos` is the queue number, or null for a skipped task. */
  | { key: string; kind: "queued"; task: TaskView; pos: number | null }
  | { key: string; kind: "plan"; plan: PlanSummary };

export interface RowContext {
  pid: string;
  actions: TaskActions;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onStop: (id: string) => void;
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
  return (
    <li
      ref={rowRef}
      style={style}
      data-row-key={entry.key}
      aria-current={selected || undefined}
      onClick={() => onSelect(entry.key)}
      className={cn(
        "flex h-10 items-center gap-2 border-b border-line px-1 text-[length:var(--text-row)] last:border-b-0",
        selected && "bg-accent outline-2 -outline-offset-2 outline-accent-brand",
      )}
    >
      <span className="flex w-5 shrink-0 justify-center">{handle}</span>
      <span className="w-20 shrink-0 truncate">
        <Marker entry={entry} pid={pid} />
      </span>
      <button
        type="button"
        onClick={open}
        className="min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[length:inherit] font-medium text-ink hover:underline"
      >
        {title}
      </button>
      {f && (
        <span className="hidden w-52 shrink-0 items-center gap-1.5 truncate text-[length:var(--text-meta)] text-ink-muted min-[720px]:flex">
          <span>p{f.priority}</span>
          {f.labels.map((l) => (
            <span key={l} className="rounded border border-line px-1">
              {l}
            </span>
          ))}
        </span>
      )}
      <span className="flex w-24 shrink-0 justify-end">
        {action && (
          <Button size="sm" variant="outline" onClick={action.run}>
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
