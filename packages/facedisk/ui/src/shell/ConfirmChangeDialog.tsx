import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import type { PendingChangeView } from "../api-types.js";
import { confirmButton, runConfirm } from "../lib/assistant-console.js";
import { DETACH_ARM_MS } from "../lib/task-delete.js";
import { ConfirmChangeBody } from "./ConfirmChangeBody.js";

/**
 * Review one change the assistant proposed. It shows the server's preview and runs the change only
 * on an explicit press. A destructive change gets a red "Confirm" that waits a moment, every
 * other change gets "Apply". On an error the dialog stays open with the message.
 */
export function ConfirmChangeDialog({
  change,
  onConfirm,
  onDiscard,
  onCancel,
}: {
  change: PendingChangeView | null;
  onConfirm: (id: string) => Promise<void>;
  onDiscard: (id: string) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [armed, setArmed] = useState(true);
  const runningRef = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = change?.id ?? null;
  const destructive = change?.destructive ?? false;
  const button = change ? confirmButton(change) : null;

  useEffect(() => {
    setError(null);
    if (!id || !destructive) {
      setArmed(true);
      return;
    }
    setArmed(false);
    const t = window.setTimeout(() => setArmed(true), DETACH_ARM_MS);
    return () => window.clearTimeout(t);
  }, [id, destructive]);

  return (
    <Dialog
      open={change !== null}
      disablePointerDismissal
      onOpenChange={(open) => !open && !running && onCancel()}
    >
      <DialogContent role="alertdialog" showCloseButton={false} initialFocus={cancel}>
        <DialogHeader>
          <DialogTitle>Review proposed change</DialogTitle>
          <DialogDescription className="sr-only">
            Review what the assistant proposes, then confirm or cancel.
          </DialogDescription>
        </DialogHeader>
        {change && <ConfirmChangeBody change={change} />}
        {error && (
          <p role="alert" className="m-0 text-[length:var(--text-row)] break-words text-failed">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancel} variant="outline" disabled={running} onClick={onCancel}>
            {button ? "Cancel" : "Close"}
          </Button>
          {change && !button && (
            <Button
              variant="outline"
              onClick={() => {
                onDiscard(change.id);
                onCancel();
              }}
            >
              Discard
            </Button>
          )}
          {button && (
            <Button
              variant={button.variant}
              disabled={!armed || running || !change}
              onClick={() =>
                change &&
                void runConfirm(() => onConfirm(change.id), {
                  running: () => runningRef.current,
                  setRunning: (on) => {
                    runningRef.current = on;
                    setRunning(on);
                  },
                  setError,
                  close: onCancel,
                })
              }
            >
              {button.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
