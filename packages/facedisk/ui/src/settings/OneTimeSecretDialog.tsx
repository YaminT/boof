import { toast } from "sonner";
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

/**
 * Shows a secret exactly once. Only "Done" closes it: Escape and clicks outside are ignored, and
 * there is no close button, so a stray key press cannot lose the key. The secret lives in this
 * dialog's props only.
 */
export function OneTimeSecretDialog({
  open,
  title,
  intro,
  secret,
  onDone,
}: {
  open: boolean;
  title: string;
  intro: string;
  secret: string;
  onDone: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy. Select the text and copy it.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{intro}</DialogDescription>
        </DialogHeader>
        <Input
          readOnly
          aria-label="Secret"
          value={secret}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-[13px]"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()}>
            Copy
          </Button>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
