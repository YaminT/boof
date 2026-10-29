import { EllipsisIcon } from "lucide-react";
import type { TaskView } from "../api.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { TaskActions } from "./useTaskActions.js";

/** The overflow menu of a row: everything that is not its primary action. No Delete here. */
export function TaskRowMenu({
  task,
  queued,
  actions,
}: {
  task: TaskView;
  queued: boolean;
  actions: TaskActions;
}) {
  const f = task.frontmatter;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More actions for ${f.title}`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <EllipsisIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {f.status === "archived" ? (
          <DropdownMenuItem onClick={() => actions.unarchive(f.id)}>Unarchive</DropdownMenuItem>
        ) : (
          f.status !== "running" && (
            <DropdownMenuItem onClick={() => actions.archive(f.id)}>Archive</DropdownMenuItem>
          )
        )}
        {queued && (
          <DropdownMenuItem onClick={() => actions.setSkip(f.id, !f.skip)}>
            {f.skip ? "Unskip" : "Skip"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => actions.duplicate(task)}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.copyId(f.id)}>Copy id</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
