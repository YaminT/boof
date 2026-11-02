import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { deleteDialogModel } from "../lib/task-delete.js";

/**
 * Confirm before deleting a task; the only place a task can be deleted. A task with subtasks asks
 * for a deliberate "Delete and detach subtasks"; `onConfirm` says whether to detach.
 */
export function DeleteTaskDialog({
  open,
  onOpenChange,
  subtasks,
  refused,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Subtasks the page knows of. */
  subtasks: number;
  /** The server refused an ordinary delete because of subtasks. */
  refused: boolean;
  onConfirm: (detach: boolean) => void;
}) {
  const m = deleteDialogModel(subtasks, refused);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{m.title}</DialogTitle>
          <DialogDescription>{m.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep task
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(m.detach)}>
            {m.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
