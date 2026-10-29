import { useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { TaskView } from "../api.js";
import { formatDuration } from "../lib/run-timing.js";
import { StatusPill } from "../shell/StatusPill.js";
import { StopTaskDialog } from "../shell/StopTaskDialog.js";
import type { TaskActions } from "../tasks/useTaskActions.js";
import { DeleteTaskDialog } from "./DeleteTaskDialog.js";

/** Back link, title, status, the one primary action and the overflow menu. */
export function TaskHeader({
  task,
  backHref,
  elapsed,
  actions,
  onDelete,
}: {
  task: TaskView;
  backHref: string;
  elapsed: number | null;
  actions: TaskActions;
  onDelete: () => void;
}) {
  const f = task.frontmatter;
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const running = f.status === "running";

  return (
    <header className="flex flex-col gap-2">
      <a
        href={backHref}
        className="w-fit text-[length:var(--text-row)] text-ink-muted no-underline hover:text-ink hover:underline"
      >
        ← Tasks
      </a>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="m-0 min-w-0 flex-1 basis-60 text-[length:var(--text-section)] leading-snug font-semibold break-words">
          {f.title}
        </h1>
        <StatusPill status={f.status} />
        {elapsed !== null && (
          <span className="text-[length:var(--text-row)] text-ink-muted tabular-nums">
            {formatDuration(elapsed)}
          </span>
        )}
        {running && (
          <Button variant="outline" onClick={() => setConfirmStop(true)}>
            Stop
          </Button>
        )}
        {f.status === "draft" && <Button onClick={() => actions.queue(f.id)}>Queue</Button>}
        {(f.status === "failed" || f.status === "stopped") && (
          <Button onClick={() => actions.retry(f.id)}>Retry</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <EllipsisIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {f.status === "archived" ? (
              <DropdownMenuItem onClick={() => actions.unarchive(f.id)}>Unarchive</DropdownMenuItem>
            ) : (
              !running && (
                <DropdownMenuItem onClick={() => actions.archive(f.id)}>Archive</DropdownMenuItem>
              )
            )}
            <DropdownMenuItem onClick={() => actions.duplicate(task)}>Duplicate</DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.copyId(f.id)}>Copy id</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={running} onClick={() => setConfirmDelete(true)}>
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <StopTaskDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        onConfirm={() => {
          setConfirmStop(false);
          actions.stop(f.id);
        }}
      />
      <DeleteTaskDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
      />
    </header>
  );
}
