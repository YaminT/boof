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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Stop task</DialogTitle>
          <DialogDescription>
            Stop this task? The agent stops and the task moves to stopped. Its worktree is kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep running
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Stop task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
