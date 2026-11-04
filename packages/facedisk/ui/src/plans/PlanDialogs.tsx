import { useEffect, useMemo, useState } from "react";
import type { Goal, ImportReport, SyncReport } from "../api.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

const label = "flex flex-col gap-1.5 text-sm font-medium";

export function NewPlanDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { title: string; description?: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>New plan</DialogTitle>
          <DialogDescription>
            A plan starts as a draft. Add goals, then activate it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || busy) return;
            setBusy(true);
            void onCreate({
              title: title.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
            }).finally(() => setBusy(false));
          }}
        >
          <label className={label}>
            Title
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className={label}>
            Description (optional)
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || busy}>
              Create plan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What an import did, or why it did not; a `plan_exists` answer offers the merge. */
export function ImportResultDialog({
  result,
  onClose,
  onMerge,
}: {
  result: { lines: string[]; exists?: boolean } | null;
  onClose: () => void;
  onMerge: () => void;
}) {
  return (
    <Dialog open={result !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>Import from repo</DialogTitle>
          <DialogDescription>
            {result?.exists ? "A plan with this id already exists." : "Result of the import."}
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {result?.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {result?.exists && <Button onClick={onMerge}>Merge into the existing plan</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const count = (n: number, word: string) => `${n} ${word}`;

/** The dry-run summary of a sync, and the button that does it. */
export function SyncDialog({
  report,
  busy,
  onConfirm,
  onClose,
}: {
  report: SyncReport | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const rows: [string, number][] = report
    ? [
        ["Created", report.created.length],
        ["Updated", report.updated.length],
        ["Skipped", report.skipped.length],
        ["Archived", report.archived.length],
      ]
    : [];
  const nothing = rows.every(([, n]) => n === 0);
  return (
    <Dialog open={report !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>Sync to tasks</DialogTitle>
          <DialogDescription>
            {nothing ? "Everything is up to date." : "This is what the sync would do."}
          </DialogDescription>
        </DialogHeader>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          {rows.map(([k, n]) => (
            <div key={k} className="contents">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="m-0 tabular-nums">{count(n, n === 1 ? "goal" : "goals")}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            Sync now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Download links for the exported files; the blob URLs are revoked when the dialog closes. */
export function ExportDialog({
  files,
  onClose,
}: {
  files: Record<string, string> | null;
  onClose: () => void;
}) {
  const links = useMemo(
    () =>
      files
        ? Object.entries(files).map(([name, content]) => ({
            name,
            url: URL.createObjectURL(new Blob([content], { type: "application/xml" })),
          }))
        : [],
    [files],
  );
  useEffect(() => () => links.forEach((l) => URL.revokeObjectURL(l.url)), [links]);
  return (
    <Dialog open={files !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>Export XML</DialogTitle>
          <DialogDescription>Download the plan and goal files.</DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-auto p-0 text-sm">
          {links.map((l) => (
            <li key={l.name}>
              <a href={l.url} download={l.name.split("/").pop()} className="font-mono text-[13px]">
                {l.name}
              </a>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchivePlanDialog({
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
          <DialogTitle>Archive plan</DialogTitle>
          <DialogDescription>
            Archive this plan? Its goals stop syncing. Tasks already made stay as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep plan
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Archive plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm a goal delete; with dependents it asks again before cascading. */
export function DeleteGoalDialog({
  goal,
  dependents,
  onClose,
  onConfirm,
}: {
  goal: Goal | null;
  /** Titles of the goals that depend on it, once the server said so; null before. */
  dependents: string[] | null;
  onClose: () => void;
  onConfirm: (cascade: boolean) => void;
}) {
  return (
    <Dialog open={goal !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete goal</DialogTitle>
          <DialogDescription>
            {dependents
              ? `These goals depend on it: ${dependents.join(", ")}. Delete them too and stop their running tasks?`
              : `Delete “${goal?.title ?? ""}” from the plan? Its task is archived on the next sync.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep goal
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(dependents !== null)}>
            {dependents ? "Delete with dependents" : "Delete goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { ImportReport };
