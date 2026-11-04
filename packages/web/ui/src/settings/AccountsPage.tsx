import { useCallback, useEffect, useState } from "react";
import type { Settings } from "@boof-runner/shared/schema";
import type { AccountsGlobal } from "../lib/settings-accounts.js";
import { api } from "../api.js";
import type { AccountSummary, AccountsHealth, PoolState, Thresholds } from "../api-types.js";
import { accountActionAccess, gatePauses } from "../lib/accounts-page.js";
import { useHeldScopes } from "../lib/useHeldScopes.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

const inputClass = "min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ink";
const labelClass = "flex min-w-0 flex-col gap-1 text-sm text-ink-muted";
const cardClass = "min-w-0 rounded-lg border border-line bg-surface p-4";

export function AccountsPage({
  settings,
  onChanged,
  advancedOpen,
  form,
  setForm,
}: {
  settings: Settings;
  onChanged: () => Promise<void>;
  advancedOpen: boolean;
  form: AccountsGlobal;
  setForm: (update: (form: AccountsGlobal) => AccountsGlobal) => void;
}) {
  const held = useHeldScopes();
  const canWrite = accountActionAccess(held);
  const [health, setHealth] = useState<AccountsHealth | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setError("");
    try {
      const [h, a] = await Promise.all([api.accountsHealth(), api.listAccounts()]);
      setHealth(h);
      setAccounts(a.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const runAccount = async (id: string, fn: () => Promise<unknown>) => {
    setRowErrors((e) => ({ ...e, [id]: "" }));
    try {
      await fn();
      await refresh();
    } catch (e) {
      setRowErrors((x) => ({ ...x, [id]: e instanceof Error ? e.message : String(e) }));
    }
  };
  const saveGateway = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateSettings({ owlishApiKey: key });
      setKey("");
      await onChanged();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const removeGateway = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateSettings({ owlish: null });
      setRemoveOpen(false);
      await onChanged();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const configured = !!settings.owlish;
  const pool = health?.pool;
  const paused = gatePauses(
    health?.healthGate ?? form.healthGate,
    pool?.status ?? ("absent" as PoolState),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove gateway?"
        body="This clears the better-ccflare gateway settings. Boof will continue to work without an account pool."
        confirmLabel="Remove gateway"
        destructive
        onConfirm={() => void removeGateway()}
      />
      {paused && (
        <div
          role="alert"
          className="rounded-md border border-attention/40 bg-attention/10 p-3 text-sm text-attention"
        >
          The account pool health gate is pausing work.{" "}
          {pool?.reason ?? "The pool is not available."}
        </div>
      )}
      <section className={cardClass}>
        <h2 className="m-0 mb-2 text-lg font-semibold">Gateway</h2>
        {!configured && (
          <p className="mt-0 text-sm text-ink-muted">
            better-ccflare is an optional pool of model accounts. Boof works normally without it;
            configure a local gateway to manage a shared account pool.
          </p>
        )}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Gateway URL
            <input
              className={inputClass}
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, enabled: true, url: e.target.value }))}
              disabled={!canWrite}
            />
          </label>
          <label className={labelClass}>
            Health gate
            <select
              className={inputClass}
              value={form.healthGate}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  enabled: true,
                  healthGate: e.target.value as typeof form.healthGate,
                }))
              }
              disabled={!canWrite}
            >
              <option value="pause">Pause work</option>
              <option value="warn">Warn only</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className={labelClass}>
            Client key (write only)
            <input
              type="password"
              autoComplete="new-password"
              className={inputClass}
              placeholder={
                health?.keySource ? "Key is set; enter to replace" : "Optional client key"
              }
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={!canWrite}
            />
          </label>
          {health?.keySource && (
            <p className="m-0 self-end text-sm text-ink-muted">
              Client key: set ({health.keySource})
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!configured && canWrite && (
            <button
              className="rounded-md bg-accent-brand px-3 py-2 text-sm text-white"
              onClick={() => setForm((f) => ({ ...f, enabled: true }))}
            >
              Use this gateway
            </button>
          )}
          {canWrite && key && (
            <button
              className="rounded-md bg-accent-brand px-3 py-2 text-sm text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void saveGateway()}
            >
              Save client key
            </button>
          )}
          {configured && canWrite && (
            <button
              className="rounded-md border border-line px-3 py-2 text-sm"
              disabled={busy}
              onClick={() => setRemoveOpen(true)}
            >
              Remove gateway
            </button>
          )}
        </div>
        {!canWrite && (
          <p className="mb-0 text-sm text-ink-muted">
            This browser key needs settings:write to change gateway settings.
          </p>
        )}
      </section>
      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">Pool status</h2>
          <button
            className="rounded-md border border-line px-3 py-2 text-sm"
            onClick={() => void refresh()}
          >
            Check now
          </button>
        </div>
        {!configured ? (
          <p className="mb-0 mt-2 text-sm text-ink-muted">No gateway configured.</p>
        ) : (
          <>
            {pool && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Status label="Status" value={pool.status} />
                <Status label="Configured" value={pool.configured} />
                <Status label="Routable" value={pool.routable} />
                <Status label="Paused" value={pool.paused} />
                <Status label="Rate-limited" value={pool.rateLimited} />
                <Status label="Usage exhausted" value={pool.usageExhausted} />
                <Status
                  label="Next available"
                  value={
                    pool.nextAvailableAt ? new Date(pool.nextAvailableAt).toLocaleString() : "—"
                  }
                />
              </div>
            )}
            {pool?.reason && <p className="mb-0 text-sm text-ink-muted">{pool.reason}</p>}
            {error && (
              <p role="alert" className="mb-0 text-sm text-red-600">
                {error}
              </p>
            )}
          </>
        )}
      </section>
      {configured && (
        <section className={cardClass}>
          <h2 className="m-0 mb-3 text-lg font-semibold">Accounts</h2>
          {accounts.length === 0 ? (
            <p className="text-sm text-ink-muted">No accounts returned by the gateway.</p>
          ) : (
            <div className="grid min-w-0 gap-3">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  canWrite={canWrite}
                  expanded={advancedOpen}
                  error={rowErrors[account.id] ?? ""}
                  run={runAccount}
                />
              ))}
            </div>
          )}
          <p className="mb-0 mt-4 text-sm text-ink-muted">
            Sign in or add an account in the{" "}
            <a
              href={
                settings.owlish?.url
                  ? `${new URL(settings.owlish.url).origin}/dashboard`
                  : undefined
              }
              target="_blank"
              rel="noreferrer"
              className="text-accent-brand underline"
            >
              better-ccflare dashboard
            </a>
            . Boof never asks for or handles provider credentials.
          </p>
        </section>
      )}
      <footer className="pb-4 text-xs text-ink-muted">
        Account pooling by better-ccflare (MIT, © 2025 snipeship &amp; tombii), a fork of ccflare by
        snipeship
      </footer>
    </div>
  );
}

function Status({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="min-w-0 rounded bg-page p-2">
      <div className="text-ink-muted">{label}</div>
      <div className="break-words font-medium text-ink">{value ?? "—"}</div>
    </div>
  );
}

function AccountRow({
  account,
  canWrite,
  expanded,
  error,
  run,
}: {
  account: AccountSummary;
  canWrite: boolean;
  expanded: boolean;
  error: string;
  run: (id: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [priority, setPriority] = useState(String(account.priority ?? 0));
  const returnedThresholds = (account.usagePauseThresholds ??
    account.thresholds ??
    {}) as Thresholds;
  const [thresholds, setThresholds] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(returnedThresholds).map(([k, v]) => [k, v === null ? "" : String(v)]),
    ),
  );
  const thresholdNames = [...new Set([...Object.keys(returnedThresholds), "fiveHour", "weekly"])];
  return (
    <article className="min-w-0 rounded-md border border-line p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 break-words font-medium">{account.name || account.id}</h3>
          <p className="m-0 break-all text-xs text-ink-muted">
            {account.id}
            {account.provider ? ` · ${account.provider}` : ""}
          </p>
        </div>
        <span className="shrink-0 rounded bg-page px-2 py-1 text-xs">
          {account.paused ? "Paused" : (account.rateLimitStatus ?? account.tokenStatus ?? "Ready")}
        </span>
      </div>
      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="rounded border border-line px-3 py-2 text-sm"
            onClick={() =>
              void run(account.id, () =>
                api.accountAction(account.paused ? "resume" : "pause", account.id),
              )
            }
          >
            {account.paused ? "Resume" : "Pause"}
          </button>
          <label className="flex items-center gap-2 text-sm">
            Priority
            <input
              aria-label={`Priority for ${account.name}`}
              className={`${inputClass} w-20`}
              type="number"
              min="0"
              max="100"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </label>
          <button
            className="rounded border border-line px-3 py-2 text-sm"
            onClick={() =>
              void run(account.id, () => api.accountPriority(account.id, Number(priority)))
            }
          >
            Set priority
          </button>
        </div>
      )}
      <details className="mt-3" open={expanded}>
        <summary className="cursor-pointer text-sm text-ink-muted">Thresholds and details</summary>
        <div className="mt-2 flex min-w-0 flex-wrap items-end gap-2 text-sm">
          {thresholdNames.map((name) => (
            <label className={labelClass} key={name}>
              {name} threshold %
              <input
                className={`${inputClass} w-28`}
                type="number"
                min="0"
                max="100"
                value={thresholds[name] ?? ""}
                onChange={(e) => setThresholds((t) => ({ ...t, [name]: e.target.value }))}
                disabled={!canWrite}
              />
            </label>
          ))}
          {canWrite && (
            <button
              className="rounded border border-line px-3 py-2"
              onClick={() =>
                void run(account.id, () =>
                  api.accountThresholds(
                    account.id,
                    Object.fromEntries(
                      Object.entries(thresholds).map(([k, v]) => [k, v === "" ? null : Number(v)]),
                    ),
                  ),
                )
              }
            >
              Set thresholds
            </button>
          )}
        </div>
        <p className="mb-0 break-words text-xs text-ink-muted">
          Priority {account.priority ?? "—"} · token {account.tokenStatus ?? "unknown"} · rate limit{" "}
          {account.rateLimitStatus ?? "unknown"}
          {account.rateLimitReset ? ` · reset ${account.rateLimitReset}` : ""}
        </p>
      </details>
      {error && (
        <p role="alert" className="mb-0 mt-2 break-words text-sm text-red-600">
          {error}
        </p>
      )}
    </article>
  );
}
