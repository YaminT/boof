import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { TaskRow, type RowContext, type RowEntry } from "./TaskRow.js";
import { TaskSection } from "./TaskSection.js";

type Queued = Extract<RowEntry, { kind: "queued" }>;

function SortableRow({
  entry,
  ctx,
  canReorder,
}: {
  entry: Queued;
  ctx: RowContext;
  canReorder: boolean;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: entry.task.frontmatter.id, disabled: !canReorder });
  return (
    <TaskRow
      entry={entry}
      ctx={ctx}
      rowRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      handle={
        canReorder && (
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Drag ${entry.task.frontmatter.title} to reorder`}
            className="cursor-grab touch-none rounded text-ink-muted hover:text-ink"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-4" />
          </button>
        )
      }
    />
  );
}

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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const ids = entries.map((e) => e.task.frontmatter.id);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  return (
    <TaskSection
      title="Queued"
      count={entries.length}
      hint={canReorder && entries.length > 1 ? "Drag or press Alt+↑ ↓ to reorder" : undefined}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="m-0 list-none p-0">
            {entries.map((e) => (
              <SortableRow key={e.key} entry={e} ctx={ctx} canReorder={canReorder} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </TaskSection>
  );
}
