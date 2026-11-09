import { join } from "node:path";
import {
  dataRootPaths,
  inspectProcessLock,
  n8nWebhookUrl,
  N8nSecretStore,
  securitySettings,
  SettingsStore,
  type ExternalStepTransport,
  type ExternalTriggerRequest,
  type ExternalTriggerResult,
} from "@boof/heart";
import { pinnedRequest } from "../server/pinned-post.js";
import {
  auditN8n,
  checkN8nTarget,
  N8N_TRIGGER_TIMEOUT_MS,
  type N8nClientOptions,
} from "./client.js";

export const NO_SERVER_MESSAGE =
  "no boof server is running on this data root to receive the n8n callback; start boof-runner serve or the desktop app";

/**
 * The runner's way to start an n8n workflow: POST the payload to the step's webhook through the
 * SSRF guard with a pinned connection. Settings are read on every call.
 */
export function createN8nTransport(
  opts: N8nClientOptions & { serverRunning?: () => Promise<boolean> },
): ExternalStepTransport {
  const serverRunning =
    opts.serverRunning ??
    (async () =>
      (await inspectProcessLock(join(dataRootPaths(opts.root).webhooks, ".dispatcher.lock"))).held);

  return {
    async preflight() {
      const settings = await new SettingsStore(opts.root).load();
      if (!settings.n8n) return "n8n is not configured";
      return (await serverRunning()) ? null : NO_SERVER_MESSAGE;
    },

    async trigger(req: ExternalTriggerRequest): Promise<ExternalTriggerResult> {
      const start = Date.now();
      const settings = await new SettingsStore(opts.root).load();
      const n8n = settings.n8n;
      if (!n8n) return { ok: false, retryable: false, reason: "n8n is not configured" };
      const url = n8nWebhookUrl(n8n, req.webhookPath);
      const target = await checkN8nTarget(
        url,
        n8n,
        securitySettings(settings).allowedPrivateWebhookHosts,
        opts,
      );
      const meta: Record<string, string | number | boolean> = {
        host: target.ok ? target.url.host : safeHost(url),
        project: req.projectId,
        task: req.taskId,
        step: req.stepId,
        runId: req.runId,
      };
      const finish = async (
        result: ExternalTriggerResult,
        httpStatus?: number,
      ): Promise<ExternalTriggerResult> => {
        await auditN8n(
          opts,
          "n8n:trigger",
          start,
          result.ok ? { ok: true } : { ok: false, reason: result.reason },
          { ...meta, ...(httpStatus ? { httpStatus } : {}) },
        );
        return result;
      };
      if (!target.ok)
        return finish({ ok: false, retryable: false, reason: `blocked: ${target.reason}` });

      const secret = await new N8nSecretStore(
        opts.root,
        opts.env ?? process.env,
      ).getWebhookSecret();
      const timeout = AbortSignal.timeout(opts.timeouts?.triggerMs ?? N8N_TRIGGER_TIMEOUT_MS);
      try {
        const res = await (opts.request ?? pinnedRequest)(target.url.href, target.addresses, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "boof-runner-n8n",
            ...(secret ? { "X-Boof-Token": secret } : {}),
            "X-Boof-Run": req.runId,
          },
          body: JSON.stringify(req.payload),
          signal: AbortSignal.any([req.signal, timeout]),
        });
        const s = res.status;
        if (s >= 200 && s < 300) return finish({ ok: true, sent: "answered" }, s);
        if (s >= 300 && s < 400)
          return finish({ ok: false, retryable: false, reason: "redirected" }, s);
        if (s === 404)
          return finish(
            {
              ok: false,
              retryable: false,
              reason: `n8n answered 404 for workflow ${req.workflowId}: is it active, and is the webhook path ${req.webhookPath.slice(0, 8)}… still right?`,
            },
            s,
          );
        if (s >= 500) return finish({ ok: false, retryable: true, reason: `HTTP ${s}` }, s);
        return finish({ ok: false, retryable: false, reason: `HTTP ${s}` }, s);
      } catch (err) {
        if (req.signal.aborted) return finish({ ok: false, retryable: false, reason: "stopped" });
        if (timeout.aborted && (err as { bodySent?: boolean }).bodySent === true)
          return finish({ ok: true, sent: "timed-out-after-send" });
        return finish({ ok: false, retryable: true, reason: "unreachable" });
      }
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
