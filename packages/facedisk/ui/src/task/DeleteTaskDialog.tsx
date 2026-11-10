import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { DETACH_ARM_MS, DELETE_TASK_WARNING, deleteDialogModel } from "../lib/task-delete.js";

export { DELETE_TASK_WARNING };

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
  const keep = useRef<HTMLButtonElement>(null);
  // The question that detaches is dangerous: focus starts on "Keep task", and the destructive
  // button waits a moment, so a repeated Enter or click cannot answer it unread.
  const [armed, setArmed] = useState(!m.detach);
  useLayoutEffect(() => {
    if (!m.detach) {
      setArmed(true);
      return;
    }
    if (!open) return;
    setArmed(false);
    const t = window.setTimeout(() => setArmed(true), DETACH_ARM_MS);
    return () => window.clearTimeout(t);
  }, [open, m.detach]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} initialFocus={keep}>
        <DialogHeader>
          <DialogTitle>{m.title}</DialogTitle>
          <DialogDescription>{m.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-wrap">
          <Button ref={keep} variant="outline" onClick={() => onOpenChange(false)}>
            Keep task
          </Button>
          <Button variant="destructive" disabled={!armed} onClick={() => onConfirm(m.detach)}>
            {m.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
