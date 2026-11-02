import { useCallback, useEffect, useMemo, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@boof-runner/shared/schema";
import { api, ApiError } from "../api.js";
import type { PublicClient, Whoami } from "../api-types.js";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { desktop } from "../desktop.js";
import { act } from "../lib/act.js";
import {
  clientState,
  isOwnKey,
  sortClients,
  toCreateClientInput,
  type ClientFormValues,
} from "../lib/clients.js";
import { relativeTime } from "../lib/time.js";
import { holdUnauthorized, releaseUnauthorized, setToken } from "../token.js";
import { TonePill } from "../shell/StatusPill.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { CreateKeyDialog } from "./CreateKeyDialog.js";
import { OneTimeSecretDialog } from "./OneTimeSecretDialog.js";

const STATE_TONE = { active: "done", expired: "attention", revoked: "neutral" } as const;

function scopesText(c: PublicClient): { text: string; title: string } {
  const all = c.scopes.join(", ");
  if (c.scopes.includes("admin")) return { text: "admin", title: all };
  if (c.scopes.length <= 2) return { text: all, title: all };
  return { text: `${c.scopes.slice(0, 2).join(", ")} and ${c.scopes.length - 2} more`, title: all };
}

function Row({
  c,
  whoami,
  projects,
  onRotate,
  onRevoke,
}: {
  c: PublicClient;
  whoami: Whoami | null;
  projects: Project[];
  onRotate: (c: PublicClient) => void;
  onRevoke: (c: PublicClient) => void;
}) {
  const state = clientState(c, Date.now());
  const sc = scopesText(c);
  const own = isOwnKey(c, whoami);
  // The desktop app keeps its own key in the OS keychain; changing it here would lock the app out.
  const locked = own && !!desktop;
  const names =
    c.projects === "*"
      ? "All projects"
      : c.projects.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(", ");
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 text-[length:var(--text-row)] last:border-b-0">
      <span className="font-medium">{c.name}</span>
      <span className="font-mono text-[length:var(--text-meta)] text-ink-muted">{c.id}</span>
      <TonePill tone={STATE_TONE[state]}>{state}</TonePill>
      <span className="text-ink-muted">{c.trust}</span>
      <span className="text-ink-muted" title={sc.title}>
        {sc.text}
      </span>
      <span className="hidden text-ink-muted min-[720px]:inline">{names}</span>
      <span className="hidden text-ink-muted min-[720px]:inline">
        {c.lastUsedAt ? `Last used ${relativeTime(c.lastUsedAt)}` : "Never used"}
      </span>
      {c.expiresAt && (
        <span className="hidden text-ink-muted min-[720px]:inline">
          Expires {new Date(c.expiresAt).toLocaleDateString()}
        </span>
      )}
      {state === "active" && (
        <span className="ml-auto flex items-center gap-1">
          {locked && (
            <span className="text-[length:var(--text-meta)] text-ink-muted">
              Desktop key: use the CLI
            </span>
          )}
          <Button size="sm" variant="outline" disabled={locked} onClick={() => onRotate(c)}>
            Rotate key
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More actions for ${c.name}`}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <EllipsisIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onClick={() =>
                  void navigator.clipboard?.writeText(c.id).then(
                    () => toast.success("Copied"),
                    () => toast.error("Could not copy."),
                  )
                }
              >
                Copy id
              </DropdownMenuItem>
              <DropdownMenuItem disabled={locked} onClick={() => onRevoke(c)}>
                Revoke key…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </li>
  );
}

/** Settings › API keys: create, rotate and revoke keys. Each change goes through its own dialog. */
export function KeysPage({ projects }: { projects: Project[] }) {
  const [clients, setClients] = useState<PublicClient[] | null>(null);
  const [loadError, setLoadError] = useState<"forbidden" | "failed" | null>(null);
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [rotating, setRotating] = useState<PublicClient | null>(null);
  const [revoking, setRevoking] = useState<PublicClient | null>(null);
  const [issued, setIssued] = useState<{ title: string; intro: string; secret: string } | null>(
    null,
  );
  const [showOld, setShowOld] = useState(false);

  const load = useCallback(async () => {
    try {
      setClients(await api.listClients());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed");
    }
  }, []);
  useEffect(() => {
    void load();
    void api
      .whoami()
      .then(setWhoami)
      .catch(() => {});
  }, [load]);

  const sorted = useMemo(() => sortClients(clients ?? [], Date.now()), [clients]);
  const active = sorted.filter((c) => clientState(c, Date.now()) === "active");
  const old = sorted.filter((c) => clientState(c, Date.now()) !== "active");

  const create = async (v: ClientFormValues) => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const r = await api.createClient(toCreateClientInput(v));
      setCreating(false);
      setIssued({
        title: "Copy this key now",
        intro: "It is shown once and cannot be recovered.",
        secret: r.key,
      });
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const authMode = whoami?.server.authMode;
  return (
    <div className="flex max-w-[1000px] flex-col gap-4">
      <p className="m-0 max-w-[80ch] text-[length:var(--text-body)] text-ink-muted">
        A key lets a harness, an MCP client or the CLI use this server. Anyone holding a key acts
        with its scopes, so grant the least you can.
      </p>
      {authMode && (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          {authMode === "required"
            ? "Every request needs a key."
            : "Requests from this computer need no key; others do."}{" "}
          Change this in settings.json.
        </p>
      )}
      <div>
        <Button
          onClick={() => {
            setCreateError(null);
            setCreating(true);
          }}
          disabled={loadError === "forbidden"}
        >
          New key
        </Button>
      </div>

      {loadError === "forbidden" ? (
        <p className="m-0 text-[length:var(--text-body)] text-attention">
          This browser&apos;s key cannot manage API keys. It needs the auth:admin scope.
        </p>
      ) : loadError === "failed" ? (
        <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
          Could not load the API keys.
          <Button variant="outline" size="xs" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : clients === null ? null : active.length === 0 && old.length === 0 ? (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          No API keys yet. Create one for a harness, an MCP client or the CLI.
        </p>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {active.map((c) => (
              <Row
                key={c.id}
                c={c}
                whoami={whoami}
                projects={projects}
                onRotate={setRotating}
                onRevoke={setRevoking}
              />
            ))}
          </ul>
          {old.length > 0 && (
            <section className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
                Revoked and expired ({old.length})
                <Button size="xs" variant="ghost" onClick={() => setShowOld((s) => !s)}>
                  {showOld ? "Hide" : "Show"}
                </Button>
              </div>
              {showOld && (
                <ul className="m-0 list-none p-0">
                  {old.map((c) => (
                    <Row
                      key={c.id}
                      c={c}
                      whoami={whoami}
                      projects={projects}
                      onRotate={setRotating}
                      onRevoke={setRevoking}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        whoami={whoami}
        projects={projects}
        error={createError}
        busy={createBusy}
        onCreate={(v) => void create(v)}
      />
      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(o) => !o && setRotating(null)}
        title="Rotate key"
        body={
          rotating
            ? `Rotate the key of “${rotating.name}”? The current key stops working at once. Boof shows the new key once.${isOwnKey(rotating, whoami) ? " This browser uses this key and switches to the new one." : ""}`
            : ""
        }
        confirmLabel="Rotate key"
        onConfirm={async () => {
          if (!rotating) return;
          const own = isOwnKey(rotating, whoami);
          // The server drops this browser's stream the moment the key changes; that 401 must not
          // raise the token gate before the new key is stored.
          if (own) holdUnauthorized();
          const r = await act(() => api.rotateClient(rotating.id), {
            failure: "Could not rotate the key",
          });
          if (!r) {
            if (own) releaseUnauthorized();
            return;
          }
          // This browser's own key just stopped working: carry on with the new one.
          if (own) setToken(r.key);
          setIssued({
            title: "Copy the new key now",
            intro: "It is shown once and cannot be recovered.",
            secret: r.key,
          });
          await load();
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke key"
        body={
          revoking
            ? `Revoke “${revoking.name}”? Its key stops working at once and cannot be restored.${isOwnKey(revoking, whoami) ? " This browser uses this key and will ask for another one." : ""}`
            : ""
        }
        confirmLabel="Revoke key"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          // Revoking this browser's own key must open the token gate, so lift any rotation hold.
          if (isOwnKey(revoking, whoami)) releaseUnauthorized();
          const r = await act(() => api.revokeClient(revoking.id), {
            success: "Key revoked",
            failure: "Could not revoke the key",
          });
          if (r) await load();
        }}
      />
      <OneTimeSecretDialog
        open={issued !== null}
        title={issued?.title ?? ""}
        intro={issued?.intro ?? ""}
        secret={issued?.secret ?? ""}
        onDone={() => setIssued(null)}
      />
    </div>
  );
}
