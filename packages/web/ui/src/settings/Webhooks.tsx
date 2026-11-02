import { useCallback, useEffect, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { toast } from "sonner";
import type { Project, PublicWebhook } from "@boof-runner/shared/schema";
import { api, ApiError } from "../api.js";
import type { Whoami } from "../api-types.js";
import { callerProjects } from "../lib/clients.js";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { act } from "../lib/act.js";
import {
  EVENT_HINTS,
  inputErrorLines,
  parseEvents,
  webhookFormProblems,
} from "../lib/automation.js";
import { sameProjects } from "../lib/automation.js";
import { sameValue } from "../lib/settings-draft.js";
import { relativeTime } from "../lib/time.js";
import { TonePill } from "../shell/StatusPill.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { OneTimeSecretDialog } from "./OneTimeSecretDialog.js";

const label = "flex flex-col gap-1.5 text-sm font-medium";

/** A webhook as listed: the address is shown as scheme://host/… and `notDelivering` says why an enabled one sends nothing. */
type Listed = PublicWebhook & { notDelivering?: string };

/** Settings › Automation: webhooks. The signing secret is shown once, in its own dialog. */
export function Webhooks({ whoami, projects }: { whoami: Whoami | null; projects: Project[] }) {
  const [list, setList] = useState<Listed[] | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PublicWebhook | null>(null);
  // The webhook the dialog edits; null while it creates one.
  const [editing, setEditing] = useState<Listed | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [scope, setScope] = useState<"*" | string[]>("*");
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listWebhooks());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const newButton = useRef<HTMLButtonElement>(null);
  const reach = callerProjects(whoami);
  const selectable = reach ? projects.filter((p) => reach.includes(p.id)) : projects;
  // While editing, an empty URL field keeps the current address (the list only shows scheme://host/…).
  const problems = webhookFormProblems(
    { url: editing && !url.trim() ? editing.url : url, events, projects: scope },
    reach,
  );
  // The problems show after a first try to create; a server error clears when the URL changes.
  const [attempted, setAttempted] = useState(false);
  const open = () => {
    setEditing(null);
    setUrl("");
    setEvents("");
    setScope(reach ? [...reach] : "*");
    setLines([]);
    setAttempted(false);
    setCreating(true);
  };
  const addHint = (h: string) =>
    setEvents((t) =>
      parseEvents(t).includes(h) && t.trim() ? t : [t.trim(), h].filter(Boolean).join(", "),
    );

  const openEdit = (w: Listed) => {
    setEditing(w);
    setUrl("");
    setEvents(w.events.join(", "));
    setScope(w.projects === "*" ? "*" : [...w.projects]);
    setLines([]);
    setAttempted(false);
    setCreating(true);
  };

  const toggle = async (w: Listed) => {
    // Decide from the webhook as it is now, not as the list last showed it.
    const fresh = (await api.listWebhooks().catch(() => [w])).find((x) => x.id === w.id) ?? w;
    await act(() => api.updateWebhook(w.id, { enabled: !fresh.enabled }), {
      success: fresh.enabled
        ? "Webhook disabled. Its events are skipped until you enable it again."
        : "Webhook enabled. It sends events from now on.",
      failure: "Could not change the webhook",
    });
    await load();
  };

  const create = async () => {
    setAttempted(true);
    if (problems.length > 0 || busy) return;
    setBusy(true);
    setLines([]);
    try {
      if (editing) {
        // Only what changed is sent; an edit never shows or changes the signing secret.
        const nextEvents = parseEvents(events);
        const patch = {
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(!sameValue([...nextEvents].sort(), [...editing.events].sort())
            ? { events: nextEvents }
            : {}),
          ...(!sameProjects(scope, editing.projects) ? { projects: scope } : {}),
        };
        if (Object.keys(patch).length > 0) {
          await api.updateWebhook(editing.id, patch);
          toast.success("Webhook saved");
        }
        setCreating(false);
        await load();
        return;
      }
      const r = await api.createWebhook({
        url: url.trim(),
        events: parseEvents(events),
        projects: scope,
      });
      setCreating(false);
      setSecret(r.secret);
      await load();
    } catch (e) {
      setLines(inputErrorLines(e));
    } finally {
      setBusy(false);
    }
  };

  const names = (w: PublicWebhook) =>
    w.projects === "*"
      ? "All projects"
      : w.projects.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(", ");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">Webhooks</h2>
        <Button ref={newButton} className="ml-auto" onClick={open} disabled={error === "forbidden"}>
          New webhook
        </Button>
      </div>
      {error === "forbidden" ? (
        <p className="m-0 text-[length:var(--text-body)] text-attention">
          This browser&apos;s key cannot manage webhooks. It needs the admin scope.
        </p>
      ) : error === "failed" ? (
        <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
          Could not load the webhooks.
          <Button variant="outline" size="xs" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : list === null ? null : list.length === 0 ? (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          No webhooks. Add one to send events to another system.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((w) => (
            <li
              key={w.id}
              className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 text-[length:var(--text-row)] last:border-b-0"
            >
              <span className="min-w-0 max-w-[28rem] truncate font-mono text-[13px]" title={w.url}>
                {w.url}
              </span>
              <span className="font-mono text-[length:var(--text-meta)] text-ink-muted">
                {w.id}
              </span>
              {!w.enabled && <TonePill tone="neutral">disabled</TonePill>}
              {w.enabled && w.notDelivering && (
                <TonePill tone="attention">not delivering: {w.notDelivering}</TonePill>
              )}
              <span className="text-ink-muted">{w.events.join(", ")}</span>
              <span className="hidden text-ink-muted min-[720px]:inline">{names(w)}</span>
              <span className="hidden text-ink-muted min-[720px]:inline">
                Created {relativeTime(w.created)}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`${w.enabled ? "Disable" : "Enable"} the webhook ${w.id} to ${w.url}`}
                  onClick={() => void toggle(w)}
                >
                  {w.enabled ? "Disable" : "Enable"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`More actions for the webhook ${w.id} to ${w.url}`}
                    className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <EllipsisIcon className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      onClick={() =>
                        void navigator.clipboard?.writeText(w.id).then(
                          () => toast.success("Copied"),
                          () => toast.error("Could not copy."),
                        )
                      }
                    >
                      Copy id
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openEdit(w)}>Edit webhook…</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDeleting(w)}>
                      Delete webhook…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent showCloseButton className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit webhook" : "New webhook"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "The signing secret does not change."
                : "Boof sends the events you choose to this URL."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className={label}>
              URL
              <Input
                autoFocus
                className="mt-0 font-mono font-normal"
                value={url}
                placeholder={
                  editing ? `${editing.url} (leave empty to keep it)` : "https://example.com/hook"
                }
                onChange={(e) => {
                  setUrl(e.target.value);
                  setLines([]);
                }}
              />
            </label>
            <label className={label}>
              Events
              <Input
                className="mt-0 font-normal"
                value={events}
                aria-label="Events"
                placeholder="task.*, plan.*"
                onChange={(e) => setEvents(e.target.value)}
              />
              <span className="flex flex-wrap gap-1.5">
                {EVENT_HINTS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => addHint(h)}
                    className="rounded-md border border-line bg-transparent px-1.5 py-0.5 font-mono text-[length:var(--text-meta)] font-normal text-ink-muted hover:text-ink"
                  >
                    {h}
                  </button>
                ))}
              </span>
              <span className="text-[length:var(--text-row)] font-normal text-ink-muted">
                Leave it empty for every event.
              </span>
            </label>
            <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1 p-0 text-sm font-medium">Projects</legend>
              <label className="check m-0 text-[length:var(--text-row)] font-normal">
                <input
                  type="radio"
                  name="wh-projects"
                  className="m-0 size-4 w-4"
                  checked={scope === "*"}
                  disabled={reach !== null}
                  onChange={() => setScope("*")}
                />
                Every project
              </label>
              <label className="check m-0 text-[length:var(--text-row)] font-normal">
                <input
                  type="radio"
                  name="wh-projects"
                  className="m-0 size-4 w-4"
                  checked={scope !== "*"}
                  onChange={() => setScope([])}
                />
                Only these projects
              </label>
              <span className="ml-6 text-[length:var(--text-meta)] text-ink-muted">
                A webhook limited to projects never receives global events such as runner.enabled.
              </span>
              {scope !== "*" && (
                <div className="ml-6 flex max-h-40 flex-col gap-1 overflow-auto">
                  {selectable.map((p) => (
                    <label
                      key={p.id}
                      className="check m-0 text-[length:var(--text-row)] font-normal"
                    >
                      <input
                        type="checkbox"
                        className="m-0 size-4 w-4"
                        checked={scope.includes(p.id)}
                        onChange={(e) =>
                          setScope(
                            e.target.checked ? [...scope, p.id] : scope.filter((x) => x !== p.id),
                          )
                        }
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            {((attempted && problems.length > 0) || lines.length > 0) && (
              <div
                role="alert"
                className="flex flex-col gap-0.5 text-[length:var(--text-row)] text-failed"
              >
                {lines.map((l) => (
                  <span key={l}>{l}</span>
                ))}
                {attempted && problems.map((p) => <span key={p}>{p}</span>)}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {editing ? "Save webhook" : "Create webhook"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete webhook"
        body={
          deleting
            ? `Delete the webhook ${deleting.id} to ${deleting.url}? Deliveries stop at once.`
            : ""
        }
        confirmLabel="Delete webhook"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const ok = await act(() => api.deleteWebhook(deleting.id), {
            success: "Webhook deleted",
            failure: "Could not delete the webhook",
          });
          if (ok) {
            await load();
            window.setTimeout(() => newButton.current?.focus(), 80);
          }
        }}
      />
      <OneTimeSecretDialog
        open={secret !== null}
        title="Copy this signing secret now"
        intro="Use it to check the X-Boof-Signature header of each delivery. It is shown once."
        secret={secret ?? ""}
        onDone={() => setSecret(null)}
      />
    </section>
  );
}
