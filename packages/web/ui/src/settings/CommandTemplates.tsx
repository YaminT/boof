import { useCallback, useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import type { CommandTemplate } from "../api-types.js";
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
import { commandIdFor } from "../lib/automation.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

const label = "flex flex-col gap-1.5 text-sm font-medium";

/** Settings › Automation: the command templates tasks can reuse. */
export function CommandTemplates({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<CommandTemplate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<CommandTemplate | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommandTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listCommands());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (t: CommandTemplate | "new") => {
    setEditing(t);
    setName(t === "new" ? "" : t.name);
    setBody(t === "new" ? "" : t.body);
  };

  const save = async () => {
    if (!editing || !name.trim() || busy) return;
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
        <Button className="ml-auto" onClick={() => open("new")}>
          New template
        </Button>
      </div>
      {failed ? (
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
                  <DropdownMenuItem onClick={() => open(t)}>Edit template</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDeleting(t)}>
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
                value={editing && editing !== "new" ? editing.id : commandIdFor(name)}
              />
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
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
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
        body={deleting ? `Delete the template “${deleting.name}”? Tasks that use it lose it.` : ""}
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
        }}
      />
    </section>
  );
}
