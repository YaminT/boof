import { useCallback, useEffect, useState } from "react";
import type { Project } from "@boof/heart/schema";
import { api } from "../api.js";
import type { N8nInfo, N8nUpdateInput, N8nWorkflowsResult, Whoami } from "../api-types.js";
import { act, errorMessage } from "../lib/act.js";
import { canAdminN8n, n8nStatusLine, shortWebhookPath } from "../lib/external-steps.js";
import { relativeTime } from "../lib/time.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import { toast } from "sonner";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { OneTimeSecretDialog } from "./OneTimeSecretDialog.js";
import { GatewayKeyField } from "./GatewayKeyField.js";

const label = "flex flex-col gap-1.5 text-sm font-medium";
const help = "text-[length:var(--text-row)] font-normal text-ink-muted";
const DEFAULT_POLL_MS = 300_000;

/** Settings › Automation: the n8n connection, its workflow list and the edit-check switches. The API key is write-only. */
export function N8nSection({ whoami, projects }: { whoami: Whoami | null; projects: Project[] }) {
  const [info, setInfo] = useState<N8nInfo | null>(null);
  const [cache, setCache] = useState<N8nWorkflowsResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [webhookBaseUrl, setWebhookBaseUrl] = useState("");
  const [callbackBaseUrl, setCallbackBaseUrl] = useState("");
  const [timeoutMin, setTimeoutMin] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [checksOn, setChecksOn] = useState(false);
  const [checksProject, setChecksProject] = useState("");
  const [autoQueue, setAutoQueue] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const admin = canAdminN8n(whoami);

  const fill = (i: N8nInfo) => {
    setBaseUrl(i.baseUrl ?? "");
    setWebhookBaseUrl(i.webhookBaseUrl ?? "");
    setCallbackBaseUrl(i.callbackBaseUrl ?? "");
    setTimeoutMin(i.defaultTimeoutMs ? String(Math.round(i.defaultTimeoutMs / 60_000)) : "");
    setChecksOn(i.checks?.enabled ?? false);
    setChecksProject(i.checks?.projectId ?? "");
    setAutoQueue(i.checks?.autoQueue ?? false);
    setApiKey("");
  };

  const load = useCallback(async () => {
    try {
      const [i, c] = await Promise.all([api.getN8n(), api.listN8nWorkflows()]);
      setInfo(i);
      setCache(c);
      fill(i);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (failed)
    return (
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">n8n</h2>
        <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
          Could not load the n8n connection.
          <Button variant="outline" size="xs" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </section>
    );
  if (!info || !cache) return null;

  const connected = info.configured;
  const minutes = timeoutMin.trim() === "" ? undefined : Number(timeoutMin);
  const withSteps = projects.filter((p) => (p.externalSteps?.length ?? 0) > 0);

  /** Only what changed; the key only when typed. */
  const buildPatch = (): N8nUpdateInput | string => {
    const patch: N8nUpdateInput = {};
    if (baseUrl.trim() !== (info.baseUrl ?? "")) patch.baseUrl = baseUrl.trim();
    if (callbackBaseUrl.trim() !== (info.callbackBaseUrl ?? ""))
      patch.callbackBaseUrl = callbackBaseUrl.trim();
    if (webhookBaseUrl.trim() !== (info.webhookBaseUrl ?? ""))
      patch.webhookBaseUrl = webhookBaseUrl.trim() === "" ? null : webhookBaseUrl.trim();
    if (minutes !== undefined) {
      if (!Number.isFinite(minutes) || minutes <= 0)
        return "The step timeout must be a number of minutes.";
      if (minutes * 60_000 !== info.defaultTimeoutMs) patch.defaultTimeoutMs = minutes * 60_000;
    }
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    const was = info.checks;
    if (
      checksOn !== (was?.enabled ?? false) ||
      autoQueue !== (was?.autoQueue ?? false) ||
      checksProject !== (was?.projectId ?? "")
    ) {
      if (checksOn && !checksProject) return "Choose the project that gets the check tasks.";
      if (checksProject)
        patch.checks = {
          enabled: checksOn,
          projectId: checksProject,
          autoQueue,
          pollIntervalMs: was?.pollIntervalMs ?? DEFAULT_POLL_MS,
        };
    }
    return patch;
  };

  const send = async (patch: N8nUpdateInput, success: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.updateN8n(patch);
      if (r.notice) toast.info(r.notice);
      toast.success(success);
      if (r.secret) setSecret(r.secret);
      // A new connection or URL needs a fresh list; a failed refresh is shown by the status line.
      if (patch.baseUrl !== undefined || patch.apiKey)
        await api.refreshN8nWorkflows().catch(() => undefined);
      await load();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const patch = buildPatch();
    if (typeof patch === "string") return setProblem(patch);
    if (!connected && (!baseUrl.trim() || !callbackBaseUrl.trim()))
      return setProblem("Enter the n8n URL and the URL n8n uses to reach boof.");
    if (connected && Object.keys(patch).length === 0) return setProblem("Nothing to save.");
    void send(patch, connected ? "n8n saved" : "n8n connected");
  };

  const refresh = async () => {
    setBusy(true);
    const r = await act(() => api.refreshN8nWorkflows(), {
      failure: "Could not refresh the workflows",
    });
    if (r) setCache(r);
    else await load();
    setBusy(false);
  };

  const fieldsDisabled = !admin || busy;
  const keyFromEnv = info.apiKeySource === "env";

  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-[length:var(--text-section)] font-semibold">n8n</h2>
      {!connected && (
        <p className="m-0 text-[length:var(--text-body)] text-ink-muted">
          n8n is optional. Connect an n8n instance to run its workflows as pipeline steps.
        </p>
      )}
      <p className="m-0 text-[length:var(--text-row)] text-ink-muted" data-testid="n8n-status">
        {n8nStatusLine(info, cache, Date.now())}
      </p>

      {admin && (
        <form
          className="flex max-w-[720px] flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className={label}>
            n8n URL
            <Input
              className="mt-0 font-mono font-normal"
              value={baseUrl}
              placeholder="http://localhost:5678"
              disabled={fieldsDisabled}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className={label}>
            Webhook URL (optional)
            <Input
              className="mt-0 font-mono font-normal"
              value={webhookBaseUrl}
              placeholder="Same as the n8n URL"
              disabled={fieldsDisabled}
              onChange={(e) => setWebhookBaseUrl(e.target.value)}
            />
            <span className={help}>
              Set it when n8n&apos;s production webhooks live at another address.
            </span>
          </label>
          <label className={label}>
            URL n8n uses to reach boof
            <Input
              className="mt-0 font-mono font-normal"
              value={callbackBaseUrl}
              placeholder="https://example.com/boof"
              disabled={fieldsDisabled}
              onChange={(e) => setCallbackBaseUrl(e.target.value)}
            />
            <span className={help}>Include the path prefix when boof runs behind a proxy.</span>
          </label>
          <label className={label}>
            Default step timeout (minutes)
            <Input
              className="mt-0 w-32 font-normal"
              inputMode="numeric"
              value={timeoutMin}
              placeholder="30"
              disabled={fieldsDisabled}
              onChange={(e) => setTimeoutMin(e.target.value)}
            />
          </label>
          {keyFromEnv ? (
            <p className="m-0 text-sm text-ink-muted">
              API key: <span className="font-mono">Set by BOOF_N8N_API_KEY</span>
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <GatewayKeyField
                label="API key"
                noun="API key"
                source={info.apiKeySource}
                value={apiKey}
                onChange={setApiKey}
                disabled={fieldsDisabled}
                hint="An n8n public API key. boof reads the workflow list with it."
              />
              {info.apiKeySource === "file" && (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void send({ apiKey: null }, "API key removed")}
                  >
                    Remove key
                  </Button>
                </div>
              )}
            </div>
          )}

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-sm font-medium">Checks</legend>
            <label className="m-0 flex flex-row items-center gap-2 text-[length:var(--text-row)] font-normal">
              <input
                type="checkbox"
                role="switch"
                className="m-0 size-4 w-4"
                checked={checksOn}
                disabled={fieldsDisabled}
                onChange={(e) => setChecksOn(e.target.checked)}
              />
              Create a check task after each workflow edit
            </label>
            {checksOn && (
              <>
                <label className={label}>
                  Project for the check tasks
                  <NativeSelect
                    value={checksProject}
                    disabled={fieldsDisabled}
                    onChange={(e) => setChecksProject(e.target.value)}
                  >
                    <option value="">Choose a project…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="m-0 flex flex-row items-center gap-2 text-[length:var(--text-row)] font-normal">
                  <input
                    type="checkbox"
                    role="switch"
                    className="m-0 size-4 w-4"
                    checked={autoQueue}
                    disabled={fieldsDisabled}
                    onChange={(e) => setAutoQueue(e.target.checked)}
                  />
                  Queue check tasks automatically (this runs the workflow)
                </label>
              </>
            )}
          </fieldset>

          {problem && (
            <p role="alert" className="m-0 text-[length:var(--text-row)] text-failed">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {connected ? "Save" : "Connect"}
            </Button>
            {connected && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  Refresh workflows
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void send({ rotateWebhookSecret: true }, "Webhook secret rotated")}
                >
                  Rotate webhook secret
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setDisconnecting(true)}
                >
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </form>
      )}
      {connected && (
        <div className="overflow-x-auto">
          {cache.workflows.length === 0 ? (
            <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
              No workflows yet. Refresh the list to load them from n8n.
            </p>
          ) : (
            <table className="w-full border-collapse text-left text-[length:var(--text-row)]">
              <thead>
                <tr className="border-b border-line text-ink-muted">
                  <th className="py-1.5 pr-3 font-medium">Name</th>
                  <th className="py-1.5 pr-3 font-medium">Active</th>
                  <th className="py-1.5 pr-3 font-medium">Updated</th>
                  <th className="py-1.5 font-medium">Webhooks</th>
                </tr>
              </thead>
              <tbody>
                {cache.workflows.map((w) => (
                  <tr key={w.id} className="border-b border-line last:border-b-0">
                    <td className="py-1.5 pr-3">
                      <div>{w.name}</div>
                      <a
                        href={w.editorUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[length:var(--text-meta)] text-ink-muted underline"
                      >
                        Open in n8n
                      </a>
                    </td>
                    <td className="py-1.5 pr-3">{w.active ? "Yes" : "No"}</td>
                    <td className="py-1.5 pr-3 text-ink-muted">{relativeTime(w.updatedAt)}</td>
                    <td className="py-1.5 font-mono text-[13px]">
                      {w.webhooks.length === 0
                        ? "–"
                        : w.webhooks.map((h) => (
                            <div key={`${h.method}-${h.path}`}>
                              {h.usable
                                ? `POST /${shortWebhookPath(h.path)}`
                                : h.method === "POST"
                                  ? `POST (not usable)`
                                  : `${h.method} (not usable)`}
                            </div>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Disconnect n8n"
        body={
          withSteps.length > 0
            ? `Remove the n8n connection, its API key and webhook secret? These projects still have external steps, which will fail until n8n is connected again: ${withSteps.map((p) => p.name).join(", ")}.`
            : "Remove the n8n connection, its API key and webhook secret?"
        }
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          const ok = await act(() => api.deleteN8n(), {
            success: "n8n disconnected",
            failure: "Could not disconnect n8n",
          });
          if (ok) await load();
        }}
      />
      <OneTimeSecretDialog
        open={secret !== null}
        title="Copy this webhook secret now"
        intro="Put this value in the n8n Webhook node's Header Auth as X-Boof-Token. It is shown only once."
        secret={secret ?? ""}
        onDone={() => setSecret(null)}
      />
    </section>
  );
}
