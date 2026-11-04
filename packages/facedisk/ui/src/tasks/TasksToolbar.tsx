import { NativeSelect } from "@/ui/native-select";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { FocusToggle } from "@/ui/focus-toggle";
import { Kbd } from "@/ui/kbd";
import type { FocusMode } from "../lib/focus-mode.js";
import type { EpicView } from "../api.js";
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
  epics,
  onEpic,
  grouping,
  onGrouping,
  onManageEpics,
  focusMode,
  onFocusToggle,
}: {
  filter: TaskFilter;
  labels: string[];
  onFilter: (next: TaskFilter) => void;
  onNew: () => void;
  /** Every epic of the project (archived ones included). */
  epics: EpicView[];
  /** The epic filter changed (null: every epic); the page keeps the URL in step. */
  onEpic: (epic: string | null) => void;
  grouping: boolean;
  onGrouping: (on: boolean) => void;
  onManageEpics: () => void;
  focusMode: FocusMode;
  onFocusToggle: () => void;
}) {
  const shown = epics.filter((e) => !e.archived || e.id === filter.epic);
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
      {(epics.length > 0 || filter.epic !== null) && (
        <NativeSelect
          aria-label="Epic"
          className="w-auto max-w-56"
          value={filter.epic ?? ""}
          onChange={(e) => onEpic(e.target.value || null)}
        >
          <option value="">All epics</option>
          <option value="none">No epic</option>
          {filter.epic !== null &&
            filter.epic !== "none" &&
            !epics.some((e) => e.id === filter.epic) && (
              <option value={filter.epic}>{filter.epic}</option>
            )}
          {shown.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
              {e.archived ? " (archived)" : ""}
            </option>
          ))}
        </NativeSelect>
      )}
      {epics.length > 0 && (
        <label className="flex h-8 items-center gap-1.5 text-[length:var(--text-row)] whitespace-nowrap text-ink">
          <input
            type="checkbox"
            checked={grouping}
            onChange={(e) => onGrouping(e.target.checked)}
          />
          Group by epic
        </label>
      )}
      <Button variant="ghost" size="sm" onClick={onManageEpics}>
        Manage epics…
      </Button>
      <FocusToggle mode={focusMode} onToggle={onFocusToggle} className="ml-auto" />
      <Kbd className="hidden min-[720px]:inline-flex">{paletteShortcutLabel()}</Kbd>
    </div>
  );
}
