import { TonePill } from "../shell/StatusPill.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { GoalStatus } from "../api.js";
import { GOAL_STATUSES, goalStatusTone } from "../lib/plan-view.js";

/** The status pill of a goal; it opens the four statuses. */
export function GoalStatusMenu({
  status,
  title,
  onChange,
}: {
  status: GoalStatus;
  title: string;
  onChange: (s: GoalStatus) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Status of ${title}: ${status}`}
        className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <TonePill tone={goalStatusTone(status)}>{status}</TonePill>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        <DropdownMenuRadioGroup value={status} onValueChange={(v) => onChange(v as GoalStatus)}>
          {GOAL_STATUSES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s} closeOnClick>
              {s}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
