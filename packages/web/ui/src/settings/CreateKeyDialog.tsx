import { useEffect, useState } from "react";
import type { Project, Scope } from "@boof-runner/shared/schema";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import type { Whoami } from "../api-types.js";
import {
  clientFormProblems,
  callerProjects,
  expiryChoices,
  initialClient,
  HARNESS_SCOPES,
  heldScopes,
  SCOPE_ORDER,
  SCOPE_TEXT,
  type ClientFormValues,
} from "../lib/clients.js";

const label = "flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium";

/** The form for a new API key. A refusal from the server shows inline and keeps the form. */
export function CreateKeyDialog({
  open,
  onOpenChange,
  whoami,
  projects,
  error,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  whoami: Whoami | null;
  /** Active projects. */
  projects: Project[];
  error: string | null;
  busy: boolean;
  onCreate: (v: ClientFormValues) => void;
}) {
  const [v, setV] = useState<ClientFormValues>(() => initialClient(whoami, Date.now()));
  // The problems show after a first try to create, not the moment the dialog opens.
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (open) {
      setV(initialClient(whoami, Date.now()));
      setAttempted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const held = heldScopes(whoami);
  const reach = callerProjects(whoami);
  const problems = clientFormProblems(v, held, reach);
  const expiry = expiryChoices(whoami, Date.now());
  const selectable = reach ? projects.filter((p) => reach.includes(p.id)) : projects;
  const isAdmin = v.scopes.includes("admin");
  const restricted = reach !== null;
  const reviewOnly = whoami?.principal.trust === "review";
  const toggle = (s: Scope, on: boolean) =>
    setV((x) => ({ ...x, scopes: on ? [...x.scopes, s] : x.scopes.filter((y) => y !== s) }));
  const owns = (s: Scope) => held === "all" || held.has(s);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New key</DialogTitle>
          <DialogDescription>Grant the least the client needs.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAttempted(true);
            if (problems.length === 0 && !busy) onCreate(v);
          }}
        >
          <label className={label}>
            Name
            <Input
              autoFocus
              className="mt-0 font-normal"
              value={v.name}
              onChange={(e) => setV({ ...v, name: e.target.value })}
            />
          </label>
          <label className={label}>
            Kind
            <NativeSelect
              className="w-full"
              value={v.kind}
              onChange={(e) => setV({ ...v, kind: e.target.value as typeof v.kind })}
            >
              <option value="harness">Harness</option>
              <option value="mcp">MCP client</option>
              <option value="cli">CLI</option>
            </NativeSelect>
          </label>

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 flex w-full items-center justify-between p-0 text-[length:var(--text-body)] font-medium">
              Scopes
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setV({ ...v, scopes: [...HARNESS_SCOPES].filter(owns) })}
              >
                Use harness scopes
              </Button>
            </legend>
            {SCOPE_ORDER.map((s) => {
              const disabled = !owns(s) || (isAdmin && s !== "admin");
              return (
                <label
                  key={s}
                  className="flex flex-row gap-2 m-0 items-start text-[length:var(--text-row)] font-normal"
                >
                  <input
                    type="checkbox"
                    className="m-0 mt-0.5 size-4 w-4"
                    checked={isAdmin ? true : v.scopes.includes(s)}
                    disabled={disabled}
                    onChange={(e) => toggle(s, e.target.checked)}
                  />
                  <span className="flex flex-col">
                    <span className="font-mono">{s}</span>
                    <span className="text-ink-muted">{SCOPE_TEXT[s]}</span>
                    {!owns(s) && (
                      <span className="text-attention">Your key does not hold this scope.</span>
                    )}
                    {s === "admin" && isAdmin && (
                      <span className="text-ink-muted">admin includes every other scope.</span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 p-0 text-[length:var(--text-body)] font-medium">
              Projects
            </legend>
            <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal">
              <input
                type="radio"
                name="key-projects"
                className="m-0 size-4 w-4"
                checked={v.projects === "*"}
                disabled={restricted}
                onChange={() => setV({ ...v, projects: "*" })}
              />
              Every project
            </label>
            <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal">
              <input
                type="radio"
                name="key-projects"
                className="m-0 size-4 w-4"
                checked={v.projects !== "*"}
                onChange={() => setV({ ...v, projects: [] })}
              />
              Only these projects
            </label>
            {v.projects !== "*" && (
              <div className="ml-6 flex max-h-40 flex-col gap-1 overflow-auto">
                {selectable.map((p) => (
                  <label
                    key={p.id}
                    className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal"
                  >
                    <input
                      type="checkbox"
                      className="m-0 size-4 w-4"
                      checked={v.projects.includes(p.id)}
                      onChange={(e) =>
                        setV({
                          ...v,
                          projects: e.target.checked
                            ? [...(v.projects as string[]), p.id]
                            : (v.projects as string[]).filter((x) => x !== p.id),
                        })
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 p-0 text-[length:var(--text-body)] font-medium">Trust</legend>
            <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal">
              <input
                type="radio"
                name="key-trust"
                className="m-0 size-4 w-4"
                checked={v.trust === "review"}
                onChange={() => setV({ ...v, trust: "review" })}
              />
              Review: its tasks and plans arrive as drafts for you to approve.
            </label>
            <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal">
              <input
                type="radio"
                name="key-trust"
                className="m-0 size-4 w-4"
                checked={v.trust === "trusted"}
                disabled={reviewOnly}
                onChange={() => setV({ ...v, trust: "trusted" })}
              />
              Trusted: it can queue tasks and activate plans.
            </label>
          </fieldset>

          <label className={label}>
            Expires
            <NativeSelect
              className="w-full"
              value={v.expiresIn}
              onChange={(e) => setV({ ...v, expiresIn: e.target.value })}
            >
              {expiry.map((c) => (
                <option key={c.value} value={c.value} disabled={c.disabled}>
                  {c.label}
                  {c.note ? ` (${c.note})` : ""}
                </option>
              ))}
            </NativeSelect>
          </label>

          {((attempted && problems.length > 0) || error) && (
            <div
              role="alert"
              className="flex flex-col gap-0.5 text-[length:var(--text-row)] text-failed"
            >
              {error && <span>{error}</span>}
              {attempted && problems.map((p) => <span key={p}>{p}</span>)}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
