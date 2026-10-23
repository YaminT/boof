import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { Modal } from "./Modal.js";
import type { PublicClient } from "../api-types.js";

const SCOPE_CHOICES = [
  "tasks:read",
  "tasks:write",
  "tasks:control",
  "settings:read",
  "settings:write",
  "auth:admin",
  "admin",
] as const;

function stateOf(c: PublicClient): "active" | "revoked" | "expired" {
  if (c.revokedAt) return "revoked";
  if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return "expired";
  return "active";
}

/** Settings > Clients: API keys for harnesses and other systems. Keys are shown once. */
export function ClientsSection() {
  const [clients, setClients] = useState<PublicClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ id: string; key: string } | null>(null);

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["tasks:read"]);
  const [trust, setTrust] = useState<"trusted" | "review">("review");
  const [expiresIn, setExpiresIn] = useState("30d");

  const load = useCallback(async () => {
    try {
      setClients(await api.listClients());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    try {
      const r = await api.createClient({
        name: name.trim(),
        scopes,
        trust,
        ...(expiresIn.trim() ? { expiresIn: expiresIn.trim() } : {}),
      });
      setCreating(false);
      setName("");
      setIssued({ id: r.client.id, key: r.key });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <h3>Clients (API keys)</h3>
      <p className="muted">
        Anyone holding a key can act as that client. Keys are root-equivalent for scopes that create
        or queue tasks; grant the least you can.
      </p>
      {error && <p className="muted">Clients unavailable: {error}</p>}
      {clients && clients.length === 0 && <p className="muted">No clients yet.</p>}
      <ul className="client-list">
        {(clients ?? []).map((c) => {
          const state = stateOf(c);
          return (
            <li key={c.id} className={`client ${state}`}>
              <strong>{c.name}</strong> <span className="muted">({c.id})</span>
              <span className={`client-state ${state}`}>{state}</span>
              <span className="muted">
                {c.trust} · {c.scopes.join(", ")}
                {c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleString()}` : ""}
                {c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleDateString()}` : ""}
              </span>
              {state === "active" && (
                <button
                  onClick={async () => {
                    if (!confirm(`Revoke “${c.name}”? Its key stops working immediately.`)) return;
                    await api.revokeClient(c.id).catch((e) => setError(String(e.message ?? e)));
                    await load();
                  }}
                >
                  Revoke
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button onClick={() => setCreating(true)}>+ New client</button>

      {creating && (
        <Modal title="New client" onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              Name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <fieldset>
              <legend>Scopes</legend>
              {SCOPE_CHOICES.map((s) => (
                <label key={s} className="scope-choice">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((cur) =>
                        e.target.checked ? [...cur, s] : cur.filter((x) => x !== s),
                      )
                    }
                  />
                  {s}
                </label>
              ))}
            </fieldset>
            <label>
              Trust
              <select
                value={trust}
                onChange={(e) => setTrust(e.target.value as "trusted" | "review")}
              >
                <option value="review">review (its tasks land in draft)</option>
                <option value="trusted">trusted (can queue tasks)</option>
              </select>
            </label>
            <label>
              Expires in (e.g. 30d, blank = never)
              <input value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
            </label>
            <div className="editor-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!name.trim() || scopes.length === 0}
              >
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}

      {issued && (
        <Modal title="Copy this key now" onClose={() => setIssued(null)}>
          <p>
            Key for <strong>{issued.id}</strong>. It is shown once and cannot be recovered.
          </p>
          <input readOnly value={issued.key} onFocus={(e) => e.currentTarget.select()} />
          <div className="editor-actions">
            <button onClick={() => void navigator.clipboard?.writeText(issued.key).catch(() => {})}>
              Copy
            </button>
            <button className="primary" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
