import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

/** Confirm before stopping a running task; used by the palette and the Overview. */
export function StopTaskDialog({
  open,
  onOpenChange,
  onConfirm,
  title = "Stop task",
  description = "Stop this task? The agent stops and the task moves to stopped. Its worktree is kept.",
  keepLabel = "Keep running",
  confirmLabel = "Stop task",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Wording for the multi-task variant (the topbar's Stop). */
  title?: string;
  description?: string;
  keepLabel?: string;
  confirmLabel?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {keepLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
