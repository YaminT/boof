import type { ReactNode } from "react";
import { SortableList } from "../shell/SortableList.js";
import { TaskRow, type RowContext, type RowEntry } from "./TaskRow.js";
import { TaskSection } from "./TaskSection.js";

type Queued = Extract<RowEntry, { kind: "queued" }>;

/** Queued rows of one epic (or all of them), with the header that goes over them. */
export interface QueuedGroup {
  key: string;
  header?: ReactNode;
  entries: Queued[];
}

/**
 * Pending tasks in run order; drag within a group to reorder. `onReorder` gets the ids of the
 * group and their new order: a drag never leaves its group, so no epic changes.
 */
export function QueuedSection({
  groups,
  ctx,
  canReorder,
  onReorder,
}: {
  groups: QueuedGroup[];
  ctx: RowContext;
  /** False while a filter hides part of the queue: the order sent must cover the whole queue. */
  canReorder: boolean;
  onReorder: (group: string[], next: string[]) => void;
}) {
  const count = groups.reduce((n, g) => n + g.entries.length, 0);
  return (
    <TaskSection
      title="Queued"
      count={count}
      hint={canReorder && count > 1 ? "Drag or press Alt+↑ ↓ to reorder" : undefined}
    >
      {groups.map((g) => {
        const byId = new Map(g.entries.map((e) => [e.task.frontmatter.id, e]));
        const ids = g.entries.map((e) => e.task.frontmatter.id);
        return (
          <div key={g.key}>
            {g.header}
            {ids.length > 0 && (
              <SortableList
                ids={ids}
                disabled={!canReorder}
                labelFor={(id) => byId.get(id)?.task.frontmatter.title ?? id}
                onReorder={(next) => onReorder(ids, next)}
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
            )}
          </div>
        );
      })}
    </TaskSection>
  );
}
