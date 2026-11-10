import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Scope, Settings } from "@boof/heart/schema";
import type { AccountsGlobal } from "../lib/settings-accounts.js";
import { api } from "../api.js";
import type {
  AccountSummary,
  AccountsHealth,
  AgentSdkEligibility,
  PoolState,
  Thresholds,
} from "../api-types.js";
import { agentSdkBadge, agentSdkSummary } from "../lib/claude-agent.js";
import { AgentSdkBadge, AgentSdkSummaryLine } from "./AgentSdkBadge.js";
import { gatePauses } from "../lib/accounts-page.js";
import { heldScopes } from "../lib/clients.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { AGENT_KEY_HINT, GatewayKeyField } from "./GatewayKeyField.js";
import type { Whoami } from "../api-types.js";
import { inputErrorLines } from "../lib/automation.js";
import { thresholdFields, accountActionAccess, priorityProblem } from "../lib/accounts-page.js";
import { TonePill } from "../shell/StatusPill.js";
import { NativeSelect } from "../ui/native-select.js";
import { Alert } from "../ui/alert.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { formatTime } from "../lib/format-time.js";

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
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  const [whoamiError, setWhoamiError] = useState("");
  const [whoamiResolved, setWhoamiResolved] = useState(false);
  useEffect(() => {
    let live = true;
    void api.whoami().then(
      (result) => {
        if (!live) return;
        setWhoami(result);
        setWhoamiResolved(true);
      },
      async (firstError) => {
        try {
          const result = await api.whoami();
          if (!live) return;
          setWhoami(result);
        } catch {
          if (!live) return;
          setWhoamiError(
            `Could not check this browser key: ${inputErrorLines(firstError).join("; ")}`,
          );
        }
        if (live) setWhoamiResolved(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const canWrite =
    whoamiResolved && !whoami
      ? true
      : accountActionAccess(
          whoami ? heldScopes(whoami) : new Set<Scope>(),
          whoami?.principal.trust ?? "trusted",
          whoami?.principal.projects ?? "*",
        );
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [health, setHealth] = useState<AccountsHealth | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [eligibility, setEligibility] = useState<AgentSdkEligibility | null>(null);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const refresh = useCallback(async (force = false) => {
    setError("");
    try {
      const [h, a, e] = await Promise.allSettled([
        api.accountsHealth(force),
        api.listAccounts(),
        api.agentSdkEligibility(force),
      ]);
      // A failed eligibility check only hides the badges; they must not say "allowed" without it.
      setEligibility(e.status === "fulfilled" ? e.value : null);
      if (h.status === "fulfilled") setHealth(h.value);
      if (a.status === "fulfilled") setAccounts(a.value.accounts);
      setListError(a.status === "rejected" ? inputErrorLines(a.reason).join("; ") : "");
      setError(h.status === "rejected" ? inputErrorLines(h.reason).join("; ") : "");
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
    }
    setCheckedAt(Date.now());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const runAccount = async (id: string, fn: () => Promise<unknown>) => {
    setRowErrors((e) => ({ ...e, [id]: "" }));
    try {
      await fn();
      await refresh();
    } catch (e) {
      setRowErrors((x) => ({ ...x, [id]: inputErrorLines(e).join("; ") }));
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
      toast.success("Client key saved");
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
    } finally {
      setBusy(false);
    }
  };
  const clearClientKey = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateSettings({ owlishApiKey: null });
      await onChanged();
      await refresh();
      toast.success("Client key cleared");
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
    } finally {
      setBusy(false);
    }
  };
  const saveAgentKey = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateSettings({ owlishAgentKey: agentKey });
      setAgentKey("");
      await onChanged();
      await refresh();
      toast.success("Agent key saved");
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
    } finally {
      setBusy(false);
    }
  };
  const clearAgentKey = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateSettings({ owlishAgentKey: null });
      await onChanged();
      await refresh();
      toast.success("Agent key cleared");
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
    } finally {
      setBusy(false);
    }
  };
  const removeGateway = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateSettings({ owlish: null, owlishApiKey: null, owlishAgentKey: null });
      setRemoveOpen(false);
      await onChanged();
      await refresh();
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
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
        body="This clears the better-ccflare gateway settings and its stored client and agent keys. Boof will continue to work without an account pool."
        confirmLabel="Remove gateway"
        destructive
        onConfirm={() => void removeGateway()}
      />
      {paused && (
        <Alert tone="attention">
          The account pool health gate is pausing work.{" "}
          {pool?.status === "unreachable"
            ? "The gateway could not be reached."
            : `Pool status: ${pool?.status ?? "unavailable"}.`}
        </Alert>
      )}
      {(error || whoamiError) && <Alert className="m-0">{whoamiError || error}</Alert>}
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
            <Input
              className={inputClass}
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, enabled: true, url: e.target.value }))}
              disabled={!canWrite}
            />
          </label>
          <label className={labelClass}>
            Health gate
            <NativeSelect
              className="min-w-0"
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
            </NativeSelect>
          </label>
          <GatewayKeyField
            label="Client key"
            noun="Client key"
            source={health?.keySource}
            value={key}
            onChange={setKey}
            disabled={!canWrite}
          />
          <GatewayKeyField
            label="Agent key"
            noun="Agent key"
            source={health?.agentKeySource}
            value={agentKey}
            onChange={setAgentKey}
            disabled={!canWrite}
            hint={AGENT_KEY_HINT}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!configured && canWrite && (
            <Button className="" onClick={() => setForm((f) => ({ ...f, enabled: true }))}>
              Use this gateway
            </Button>
          )}
          {canWrite && key && (
            <Button className="" disabled={busy} onClick={() => void saveGateway()}>
              Save client key
            </Button>
          )}
          {canWrite && agentKey && (
            <Button className="" disabled={busy} onClick={() => void saveAgentKey()}>
              Save agent key
            </Button>
          )}
          {configured && canWrite && (
            <Button variant="outline" disabled={busy} onClick={() => setRemoveOpen(true)}>
              Remove gateway
            </Button>
          )}
          {health?.keySource === "file" && canWrite && (
            <Button variant="outline" disabled={busy} onClick={() => void clearClientKey()}>
              Clear client key
            </Button>
          )}
          {health?.agentKeySource === "file" && canWrite && (
            <Button variant="outline" disabled={busy} onClick={() => void clearAgentKey()}>
              Clear agent key
            </Button>
          )}
          {health?.agentKeySource === "env" && (
            <p className="m-0 self-center text-sm text-ink-muted">
              Agent key comes from BOOF_OWLISH_AGENT_KEY and cannot be cleared here.
            </p>
          )}
          {health?.keySource === "env" && (
            <p className="m-0 self-center text-sm text-ink-muted">
              Client key comes from BOOF_OWLISH_API_KEY and cannot be cleared here.
            </p>
          )}
        </div>
        {!canWrite && (
          <p className="mb-0 text-sm text-ink-muted">
            Changing the gateway needs a trusted key without a project restriction.
          </p>
        )}
      </section>
      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">Pool status</h2>
          <Button variant="outline" onClick={() => void refresh(true)}>
            Check now
          </Button>
        </div>
        {checkedAt && (
          <p className="m-0 text-xs text-ink-muted">
            Checked {Math.max(0, Math.floor((now - checkedAt) / 1000))} s ago
          </p>
        )}
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
                  value={pool.nextAvailableAt ? formatTime(pool.nextAvailableAt) : "—"}
                />
              </div>
            )}
          </>
        )}
      </section>
      {configured && (
        <section className={cardClass}>
          <h2 className="m-0 mb-3 text-lg font-semibold">Accounts</h2>
          {listError && <Alert>Could not load accounts: {listError}</Alert>}
          <AgentSdkSummaryLine text={agentSdkSummary(eligibility)} />
          {accounts.length === 0 && !listError ? (
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
                  agentBadge={agentSdkBadge(account.id, eligibility)}
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
      {accounts.some((a) =>
        /oauth|subscription/i.test(
          `${a.provider ?? ""} ${a.authType ?? ""} ${a.accountType ?? ""}`,
        ),
      ) && (
        <p className="m-0 text-sm text-ink-muted">
          Check your provider&apos;s terms before pooling subscription accounts.
        </p>
      )}
      <footer className="pb-4 text-xs text-ink-muted">
        Account pooling by{" "}
        <a
          className="underline"
          href="https://github.com/tombii/better-ccflare"
          target="_blank"
          rel="noreferrer"
        >
          better-ccflare
        </a>{" "}
        (MIT, © 2025 snipeship &amp; tombii), a fork of ccflare by snipeship.
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
  agentBadge,
  run,
}: {
  account: AccountSummary;
  agentBadge: { allowed: boolean; text: string } | null;
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
    Object.fromEntries(thresholdFields(returnedThresholds)),
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
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <AgentSdkBadge badge={agentBadge} />
          <TonePill
            tone={
              account.paused
                ? "attention"
                : account.rateLimitStatus === "rate_limited"
                  ? "failed"
                  : "done"
            }
          >
            {account.paused
              ? "Paused"
              : (account.rateLimitStatus ?? account.tokenStatus ?? "Ready")
                  .replaceAll("_", " ")
                  .replace(/^\w/, (c) => c.toUpperCase())}
          </TonePill>
        </div>
      </div>
      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void run(account.id, () =>
                api.accountAction(account.paused ? "resume" : "pause", account.id),
              )
            }
          >
            {account.paused ? "Resume" : "Pause"}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            Priority
            <Input
              aria-label={`Priority for ${account.name}`}
              className={`${inputClass} w-20`}
              type="number"
              min="0"
              max="100"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            onClick={() =>
              void run(account.id, async () => {
                const problem = priorityProblem(priority);
                if (problem) throw new Error(problem);
                return api.accountPriority(account.id, Number(priority));
              })
            }
          >
            Set priority
          </Button>
        </div>
      )}
      <details className="mt-3" open={expanded}>
        <summary className="cursor-pointer text-sm text-ink-muted">Thresholds and details</summary>
        <div className="mt-2 flex min-w-0 flex-wrap items-end gap-2 text-sm">
          {thresholdNames.map((name) => (
            <label className={labelClass} key={name}>
              {name === "fiveHour"
                ? `5-hour usage pause threshold for ${account.name || account.id} (%)`
                : name === "weekly"
                  ? `Weekly usage pause threshold for ${account.name || account.id} (%)`
                  : `${name} threshold for ${account.name || account.id} (%)`}
              <Input
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
            <Button
              variant="outline"
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
            </Button>
          )}
        </div>
        <p className="mb-0 break-words text-xs text-ink-muted">
          Priority {account.priority ?? "—"} · token {account.tokenStatus ?? "unknown"} · rate limit{" "}
          {account.rateLimitStatus ?? "unknown"}
          {account.rateLimitReset ? ` · reset ${formatTime(account.rateLimitReset)}` : ""}
        </p>
      </details>
      {error && <Alert className="mb-0 mt-2 break-words">{error}</Alert>}
    </article>
  );
}
