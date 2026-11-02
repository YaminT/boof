import { useState } from "react";
import type { Scope } from "@boof-runner/shared/schema";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/ui/sheet";
import { api, type EpicView, type TaskView } from "../api.js";
import { act } from "../lib/act.js";
import { epicDetachNote, epicUsage, needsDetach, parseEpicForm } from "../lib/epics-manage.js";
import { progressLabel } from "../lib/task-hierarchy.js";
import { ConfirmDialog } from "../settings/ConfirmDialog.js";
import { TonePill } from "../shell/StatusPill.js";
import type { Epics } from "./useEpics.js";

const field = "flex flex-col gap-1 text-sm font-medium";

/** Add, rename, reprioritise, archive and delete the project's epics. */
export function ManageEpicsSheet({
  open,
  onOpenChange,
  pid,
  epics,
  tasks,
  held,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pid: string;
  epics: Epics;
  tasks: TaskView[];
  held: ReadonlySet<Scope> | "all";
  /** Tasks may have changed (their epic): reload the list. */
  onChanged: () => void;
}) {
  const canWrite = held === "all" || held.has("tasks:write");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", priority: "" });
  const [deleting, setDeleting] = useState<EpicView | null>(null);
  const [detaching, setDetaching] = useState<EpicView | null>(null);

  const created = parseEpicForm({ title, priority });
  const changed = async (done: Promise<unknown>) => {
    await done;
    await epics.reload();
    onChanged();
  };

  const add = async () => {
    setAttempted(true);
    if (!created.ok) return;
    const made = await act(() => api.createEpic(pid, created.value), {
      success: "Epic added",
      failure: "Could not add the epic",
    });
    if (made) {
      setTitle("");
      setPriority("");
      setAttempted(false);
    }
    await changed(Promise.resolve());
  };

  const startEdit = (e: EpicView) => {
    setEditing(e.id);
    setDraft({ title: e.title, priority: String(e.priority) });
  };
  const saveEdit = async (e: EpicView) => {
    const parsed = parseEpicForm(draft);
    if (!parsed.ok) return;
    const ok = await act(
      () => api.updateEpic(pid, e.id, { ...parsed.value, expectedUpdated: e.updated }),
      { success: "Epic saved", failure: "Could not save the epic" },
    );
    if (ok) setEditing(null);
    await changed(Promise.resolve());
  };
  const archive = (e: EpicView, archived: boolean) =>
    changed(
      act(() => api.updateEpic(pid, e.id, { archived, expectedUpdated: e.updated }), {
        success: archived ? "Epic archived" : "Epic restored",
        failure: archived ? "Could not archive" : "Could not restore",
      }),
    );

  // Delete asks first; tasks that still name the epic bring a second, explicit choice.
  const remove = async (e: EpicView) => {
    const ok = await act(() => api.deleteEpic(pid, e.id), {
      success: "Epic deleted",
      failure: "Could not delete the epic",
      onError: (err) => {
        if (!needsDetach(err)) return false;
        setDetaching(e);
        return true;
      },
    });
    if (ok) await changed(Promise.resolve());
  };
  const detachAndDelete = async (e: EpicView) => {
    await changed(
      act(() => api.deleteEpic(pid, e.id, true), {
        success: "Epic deleted; its tasks have no epic now",
        failure: "Could not delete the epic",
      }),
    );
  };

  const problems = attempted && !created.ok ? created.problems : [];
  const editProblems = (() => {
    const p = parseEpicForm(draft);
    return p.ok ? [] : p.problems;
  })();
  const usage = detaching ? epicUsage(tasks, detaching.id) : null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Manage epics</SheetTitle>
            <SheetDescription>
              An epic groups tasks of this project. Archiving keeps the grouping; deleting clears
              it.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4 pb-6">
            {!canWrite && (
              <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
                This key can read epics but not change them.
              </p>
            )}
            <form
              className="flex flex-col gap-2"
              noValidate
              onSubmit={(ev) => {
                ev.preventDefault();
                void add();
              }}
            >
              <div className="flex flex-wrap items-end gap-2">
                <label className={`${field} min-w-40 flex-1`}>
                  New epic
                  <Input
                    value={title}
                    disabled={!canWrite}
                    placeholder="Name"
                    onChange={(e) => setTitle(e.target.value)}
                    aria-invalid={attempted && !created.ok}
                  />
                </label>
                <label className={`${field} w-20`}>
                  Priority
                  <Input
                    inputMode="numeric"
                    value={priority}
                    disabled={!canWrite}
                    placeholder="0"
                    onChange={(e) => setPriority(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={!canWrite}>
                  Add epic
                </Button>
              </div>
              {problems.length > 0 && (
                <p role="alert" className="m-0 text-[length:var(--text-row)] text-failed">
                  {problems.join(" ")}
                </p>
              )}
            </form>
            {epics.list.length === 0 ? (
              <p className="m-0 text-ink-muted">No epics yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {epics.list.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-col gap-2 border-b border-line py-2 last:border-b-0"
                  >
                    {editing === e.id ? (
                      <>
                        <div className="flex flex-wrap items-end gap-2">
                          <label className={`${field} min-w-40 flex-1`}>
                            Name
                            <Input
                              value={draft.title}
                              onChange={(ev) => setDraft({ ...draft, title: ev.target.value })}
                            />
                          </label>
                          <label className={`${field} w-20`}>
                            Priority
                            <Input
                              inputMode="numeric"
                              value={draft.priority}
                              onChange={(ev) => setDraft({ ...draft, priority: ev.target.value })}
                            />
                          </label>
                        </div>
                        {editProblems.length > 0 && (
                          <p role="alert" className="m-0 text-[length:var(--text-row)] text-failed">
                            {editProblems.join(" ")}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={editProblems.length > 0}
                            onClick={() => void saveEdit(e)}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="min-w-0 flex-1 font-medium break-words">{e.title}</span>
                          {e.archived && <TonePill tone="neutral">archived</TonePill>}
                          <span className="text-[length:var(--text-meta)] text-ink-muted tabular-nums">
                            p{e.priority} · {progressLabel(e.progress)} done
                          </span>
                        </div>
                        {canWrite && (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => startEdit(e)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void archive(e, !e.archived)}
                            >
                              {e.archived ? "Restore" : "Archive"}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setDeleting(e)}>
                              Delete…
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete epic"
        body={
          deleting
            ? `Delete the epic “${deleting.title}”? If tasks still use it you will be asked what to do with them.`
            : ""
        }
        confirmLabel="Delete epic"
        destructive
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
      <Dialog open={detaching !== null} onOpenChange={(o) => !o && setDetaching(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>This epic still has tasks</DialogTitle>
            <DialogDescription>
              {detaching && usage && epicDetachNote(detaching.title, usage)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-wrap">
            <Button variant="outline" onClick={() => setDetaching(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const e = detaching;
                setDetaching(null);
                if (e) void archive(e, true);
              }}
            >
              Archive instead
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const e = detaching;
                setDetaching(null);
                if (e) void detachAndDelete(e);
              }}
            >
              Delete and detach tasks
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
