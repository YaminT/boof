import type { CSSProperties, ReactNode, Ref } from "react";
import type { Goal, GoalStatus, TaskView } from "../api.js";
import { cn } from "@/lib/utils";
import { dependsOnTitles } from "../lib/plan-view.js";
import { StatusPill, TonePill } from "../shell/StatusPill.js";
import { GoalStatusMenu } from "./GoalStatusMenu.js";

/** One goal: order, title, status pill, dependencies, linked task and an overflow menu. */
export function GoalRow({
  goal,
  goals,
  task,
  taskHref,
  selected,
  onOpen,
  onStatus,
  menu,
  handle,
  rowRef,
  style,
}: {
  goal: Goal;
  goals: Goal[];
  task: TaskView | undefined;
  taskHref: string | null;
  selected: boolean;
  onOpen(): void;
  onStatus(s: GoalStatus): void;
  menu: ReactNode;
  handle?: ReactNode;
  rowRef?: Ref<HTMLLIElement>;
  style?: CSSProperties;
}) {
  const deps = dependsOnTitles(goal, goals);
  return (
    <li
      ref={rowRef}
      style={style}
      data-goal-id={goal.id}
      aria-current={selected || undefined}
      className={cn(
        "flex h-10 items-center gap-2 border-b border-line px-1 text-[length:var(--text-row)] last:border-b-0",
        selected && "bg-accent outline-2 -outline-offset-2 outline-accent-brand",
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">{handle}</span>
      <span className="w-6 shrink-0 text-right tabular-nums text-ink-muted">{goal.order}</span>
      <a
        href={`#goal-${goal.id}`}
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
        className="min-w-[6rem] flex-1 truncate font-medium text-ink no-underline hover:underline"
      >
        {goal.title}
      </a>
      <GoalStatusMenu status={goal.status} title={goal.title} onChange={onStatus} />
      {deps.length > 0 && (
        <span className="hidden max-w-60 shrink items-center gap-1.5 truncate text-[length:var(--text-meta)] text-ink-muted min-[720px]:flex">
          {deps.map((d) =>
            d.missing ? (
              <span key={d.id} className="flex items-center gap-1">
                {d.id} <TonePill tone="failed">missing</TonePill>
              </span>
            ) : (
              <span key={d.id} className="truncate">
                {d.title}
              </span>
            ),
          )}
        </span>
      )}
      <span className="flex w-20 shrink-0 justify-end">
        {task && taskHref ? (
          <a href={taskHref} className="no-underline" aria-label={`Task of ${goal.title}`}>
            <StatusPill status={task.frontmatter.status} />
          </a>
        ) : (
          <span className="text-ink-muted">–</span>
        )}
      </span>
      <span className="flex size-7 shrink-0 justify-center">{menu}</span>
    </li>
  );
}
