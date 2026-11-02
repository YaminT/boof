import { SortableList } from "../shell/SortableList.js";
import { TaskRow, type RowContext, type RowEntry } from "./TaskRow.js";
import { TaskSection } from "./TaskSection.js";

type Queued = Extract<RowEntry, { kind: "queued" }>;

/** Pending tasks in run order; drag within the list to reorder. */
export function QueuedSection({
  entries,
  ctx,
  canReorder,
  onReorder,
}: {
  entries: Queued[];
  ctx: RowContext;
  /** False while a filter hides part of the queue: the order sent must cover the whole queue. */
  canReorder: boolean;
  onReorder: (order: string[]) => void;
}) {
  const byId = new Map(entries.map((e) => [e.task.frontmatter.id, e]));
  const ids = entries.map((e) => e.task.frontmatter.id);
  return (
    <TaskSection
      title="Queued"
      count={entries.length}
      hint={canReorder && entries.length > 1 ? "Drag or press Alt+↑ ↓ to reorder" : undefined}
    >
      <SortableList
        ids={ids}
        disabled={!canReorder}
        labelFor={(id) => byId.get(id)?.task.frontmatter.title ?? id}
        onReorder={onReorder}
      >
        {(id, handle, row) => {
          const e = byId.get(id);
          return e ? (
            <TaskRow
              key={e.key}
              entry={e}
              ctx={ctx}
              rowRef={row.rowRef}
              style={row.style}
              handle={handle}
            />
          ) : null;
        }}
      </SortableList>
    </TaskSection>
  );
}
