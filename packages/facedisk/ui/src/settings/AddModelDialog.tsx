import { useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

/** Adds a model name to a tool's list; the page is saved with "Save changes". */
export function AddModelDialog({
  tool,
  onClose,
  onAdd,
}: {
  tool: string | null;
  onClose: () => void;
  onAdd: (tool: string, model: string) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (tool) setName("");
  }, [tool]);
  return (
    <Dialog open={tool !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>Add a model for {tool}</DialogTitle>
          <DialogDescription>
            The model is saved with the page, under Save changes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (tool && name.trim()) {
              onAdd(tool, name.trim());
              onClose();
            }
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Model name
            <Input
              autoFocus
              className="mt-0 font-mono font-normal"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Add model
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
