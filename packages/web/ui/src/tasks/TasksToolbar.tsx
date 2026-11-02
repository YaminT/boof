import { NativeSelect } from "@/ui/native-select";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import type { TaskFilter } from "../lib/task-list.js";
import { paletteShortcutLabel } from "../shell/CommandPalette.js";

const STATES: { value: TaskFilter["state"]; label: string }[] = [
  { value: "all", label: "All states" },
  { value: "needs-you", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "drafts", label: "Drafts" },
  { value: "finished", label: "Finished" },
];

export function TasksToolbar({
  filter,
  labels,
  onFilter,
  onNew,
  epicTitle,
  onClearEpic,
}: {
  filter: TaskFilter;
  labels: string[];
  onFilter: (next: TaskFilter) => void;
  onNew: () => void;
  /** The epic the list is limited to ("none": tasks without one), or null. */
  epicTitle: string | null;
  onClearEpic: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button onClick={onNew}>New task</Button>
      <Input
        type="search"
        aria-label="Search tasks"
        placeholder="Search tasks"
        value={filter.query}
        onChange={(e) => onFilter({ ...filter, query: e.target.value })}
        className="mt-0 w-full min-[720px]:w-64"
      />
      <NativeSelect
        aria-label="State"
        className="w-auto"
        value={filter.state}
        onChange={(e) => onFilter({ ...filter, state: e.target.value as TaskFilter["state"] })}
      >
        {STATES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </NativeSelect>
      {labels.length > 0 && (
        <NativeSelect
          aria-label="Label"
          className="w-auto"
          value={filter.label ?? ""}
          onChange={(e) => onFilter({ ...filter, label: e.target.value || null })}
        >
          <option value="">All labels</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </NativeSelect>
      )}
      {filter.epic !== null && (
        <Button variant="outline" size="sm" onClick={onClearEpic} className="max-w-full">
          <span className="truncate">
            {filter.epic === "none" ? "No epic" : `Epic: ${epicTitle ?? filter.epic}`}
          </span>
          <span aria-hidden>×</span>
          <span className="sr-only">Clear the epic filter</span>
        </Button>
      )}
      <Kbd className="ml-auto hidden min-[720px]:inline-flex">{paletteShortcutLabel()}</Kbd>
    </div>
  );
}
