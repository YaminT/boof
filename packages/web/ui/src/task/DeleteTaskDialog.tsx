import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

/** Confirm before deleting a task; the only place a task can be deleted. */
export function DeleteTaskDialog({
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
          <DialogTitle>Delete task</DialogTitle>
          <DialogDescription>
            Delete this task? Its file, reports and log are removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep task
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
