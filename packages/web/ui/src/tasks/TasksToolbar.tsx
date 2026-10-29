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

const SELECT =
  "mt-0 block h-8 w-auto rounded-lg border border-input bg-transparent px-2 py-0 text-[length:var(--text-row)] text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function TasksToolbar({
  filter,
  labels,
  onFilter,
  onNew,
}: {
  filter: TaskFilter;
  labels: string[];
  onFilter: (next: TaskFilter) => void;
  onNew: () => void;
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
      <select
        aria-label="State"
        className={SELECT}
        value={filter.state}
        onChange={(e) => onFilter({ ...filter, state: e.target.value as TaskFilter["state"] })}
      >
        {STATES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {labels.length > 0 && (
        <select
          aria-label="Label"
          className={SELECT}
          value={filter.label ?? ""}
          onChange={(e) => onFilter({ ...filter, label: e.target.value || null })}
        >
          <option value="">All labels</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )}
      <Kbd className="ml-auto hidden min-[720px]:inline-flex">{paletteShortcutLabel()}</Kbd>
    </div>
  );
}
