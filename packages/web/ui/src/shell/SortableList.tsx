import type { CSSProperties, ReactNode, Ref } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";

export interface SortableRowProps {
  /** Goes on the row element (`<li>`) and its `style`, so it can move while dragged. */
  rowRef: Ref<HTMLLIElement>;
  style: CSSProperties;
}

function Item({
  id,
  label,
  disabled,
  children,
}: {
  id: string;
  label: string;
  disabled: boolean;
  children: (handle: ReactNode, row: SortableRowProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id, disabled });
  const handle = disabled ? null : (
    <button
      type="button"
      ref={setActivatorNodeRef}
      aria-label={`Drag ${label} to reorder`}
      className="cursor-grab touch-none rounded text-ink-muted outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
      {...attributes}
      {...listeners}
    >
      <GripVerticalIcon className="size-4" />
    </button>
  );
  return children(handle, {
    rowRef: setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition },
  });
}

/**
 * A vertical list whose rows move by pointer drag or, from the row's handle, by keyboard (Space
 * to pick up, arrows to move, Space to drop). `onReorder` gets the full new id order.
 */
export function SortableList({
  ids,
  disabled = false,
  labelFor,
  onReorder,
  children,
}: {
  ids: string[];
  disabled?: boolean;
  labelFor: (id: string) => string;
  onReorder: (order: string[]) => void;
  children: (id: string, handle: ReactNode, row: SortableRowProps) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space to pick up the row, the arrow keys to move it, and Space again to drop it. Alt and the arrow keys move a focused row.",
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="m-0 list-none p-0">
          {ids.map((id) => (
            <Item key={id} id={id} label={labelFor(id)} disabled={disabled}>
              {(handle, row) => children(id, handle, row)}
            </Item>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
