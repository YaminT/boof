import { useCallback, useEffect, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../api.js";
import type { CommandTemplate, Whoami } from "../api-types.js";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { act } from "../lib/act.js";
import {
  canChangeTemplates,
  commandIdFor,
  TEMPLATE_RULE,
  templateFormProblems,
} from "../lib/automation.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

const label = "flex flex-col gap-1.5 text-sm font-medium";

/** Settings › Automation: the command templates tasks can reuse. */
export function CommandTemplates({
  whoami,
  onChange,
}: {
  whoami: Whoami | null;
  onChange: () => void;
}) {
  const [list, setList] = useState<CommandTemplate[] | null>(null);
  const [failed, setFailed] = useState<"forbidden" | "failed" | null>(null);
  const [attempted, setAttempted] = useState(false);
  const allowed = canChangeTemplates(whoami);
  // The row a menu action acted on may be gone, so focus goes back to the page's main button.
  const newButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<CommandTemplate | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommandTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listCommands());
      setFailed(null);
    } catch (e) {
      setFailed(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (t: CommandTemplate | "new") => {
    setEditing(t);
    setAttempted(false);
    setName(t === "new" ? "" : t.name);
    setBody(t === "new" ? "" : t.body);
  };

  const problems = templateFormProblems(
    name,
    (list ?? []).map((t) => t.id),
    editing && editing !== "new" ? editing.id : null,
  );
  const newId = commandIdFor(name);
  const renamed = editing !== null && editing !== "new" && !!name.trim() && newId !== editing.id;

  const save = async () => {
    if (!editing || busy) return;
    setAttempted(true);
    if (problems.length > 0) return;
    setBusy(true);
    const ok = await act(
      () =>
        editing === "new"
          ? api.upsertCommand(name.trim(), body)
          : api.renameCommand(editing.id, name.trim(), body),
      { failure: "Could not save the template", success: "Template saved" },
    );
    setBusy(false);
    if (ok) {
      setEditing(null);
      await load();
      onChange();
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">Command templates</h2>
        <Button ref={newButton} className="ml-auto" onClick={() => open("new")} disabled={!allowed}>
          New template
        </Button>
      </div>
      {!allowed && (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">{TEMPLATE_RULE}</p>
      )}
      {failed === "forbidden" ? (
        <p className="m-0 text-[length:var(--text-body)] text-attention">
          This browser&apos;s key cannot read command templates. It needs the tasks:read scope.
        </p>
      ) : failed === "failed" ? (
        <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
          Could not load the templates.
          <Button variant="outline" size="xs" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : list === null ? null : list.length === 0 ? (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          No command templates yet. A template is a set of instructions a task can reuse.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((t) => (
            <li
              key={t.id}
              className="flex h-10 items-center gap-3 border-b border-line text-[length:var(--text-row)] last:border-b-0"
            >
              <span className="font-medium">{t.name}</span>
              <span className="font-mono text-[length:var(--text-meta)] text-ink-muted">
                {t.id}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`More actions for ${t.name}`}
                  className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <EllipsisIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem disabled={!allowed} onClick={() => open(t)}>
                    Edit template
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!allowed} onClick={() => setDeleting(t)}>
                    Delete template…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent showCloseButton className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "New template" : "Edit template"}</DialogTitle>
            <DialogDescription>Instructions a task can reuse.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className={label}>
              Name
              <Input
                autoFocus
                className="mt-0 font-normal"
                value={name}
                placeholder="Secure Feature"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={label}>
              Id
              <Input
                readOnly
                className="mt-0 font-mono font-normal"
                value={name.trim() ? newId : editing && editing !== "new" ? editing.id : ""}
              />
              {renamed && (
                <span className="text-[length:var(--text-row)] font-normal text-ink-muted">
                  The id changes. Tasks that use this template are updated.
                </span>
              )}
            </label>
            <label className={label}>
              Instructions
              <Textarea
                className="plain-font mt-0 font-normal"
                rows={14}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {attempted && problems.length > 0 && (
              <div
                role="alert"
                className="flex flex-col gap-0.5 text-[length:var(--text-row)] text-failed"
              >
                {problems.map((p) => (
                  <span key={p}>{p}</span>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {editing === "new" ? "Create template" : "Save template"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete template"
        body={
          deleting
            ? `Delete the template “${deleting.name}”? Tasks that use it keep their own copy of the instructions.`
            : ""
        }
        confirmLabel="Delete template"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await act(() => api.deleteCommand(deleting.id), {
            failure: "Could not delete the template",
          });
          if (!res) return;
          toast.success(
            res.referencedBy.length > 0
              ? `Template deleted. These tasks used it: ${res.referencedBy.join(", ")}`
              : "Template deleted",
          );
          await load();
          onChange();
          window.setTimeout(() => newButton.current?.focus(), 80);
        }}
      />
    </section>
  );
}
