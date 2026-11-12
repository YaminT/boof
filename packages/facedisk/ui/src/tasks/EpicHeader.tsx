import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { EpicSection } from "../lib/epic-grouping.js";
import { progressLabel } from "../lib/task-hierarchy.js";
import { TonePill } from "../shell/StatusPill.js";

/** One line over an epic's rows: title, priority, progress and a fold toggle. */
export function EpicHeader({
  section,
  shown,
  collapsed,
  onToggle,
}: {
  section: EpicSection;
  /** Rows of this epic in the section below. */
  shown: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const title = section.label ?? section.epic?.title ?? "No epic";
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="mt-2 flex h-8 w-full items-center gap-2 border-b border-line bg-transparent px-1 text-left text-[length:var(--text-row)] text-ink outline-none first:mt-0 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Chevron aria-hidden className="size-4 shrink-0 text-ink-muted" />
      <span className="min-w-0 truncate font-medium">{title}</span>
      {section.archived && <TonePill tone="neutral">archived</TonePill>}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[length:var(--text-meta)] text-ink-muted tabular-nums">
        {section.epic && <span>p{section.epic.priority}</span>}
        {section.progress && (
          <span title={`${section.progress.done} of ${section.progress.total} tasks done`}>
            {progressLabel(section.progress)}
          </span>
        )}
        <span>{shown} here</span>
      </span>
    </button>
  );
}
