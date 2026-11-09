import net from "node:net";
import {
  joinUrl,
  N8nSecretStore,
  securitySettings,
  SettingsStore,
  auditOperation,
  type N8nSettings,
} from "@boof/heart";
import { OpError } from "../api/errors.js";
import { checkWebhookTarget, hostnameOf, resolveHost as defaultResolve } from "../api/net-guard.js";
import type { ResolveHost } from "../api/net-guard.js";
import { assertWebhookUrl } from "../api/ops/webhooks.js";
import { pinnedRequest } from "../server/pinned-post.js";
import {
  readWorkflowCache,
  summarizeWorkflow,
  writeWorkflowCache,
  type N8nWorkflowCache,
  type N8nWorkflowSummary,
} from "./workflows.js";

export interface N8nClientOptions {
  root: string;
  resolveHost?: ResolveHost;
  isSelfUrl?: (u: URL) => boolean;
  /** Test seam; receives the checked addresses. */
  request?: typeof pinnedRequest;
  /** Audit `via`, default "server". */
  via?: "server" | "runner";
  /** For BOOF_N8N_API_KEY. */
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults 10_000 / 30_000. */
  timeouts?: { triggerMs?: number; pageMs?: number };
}

export const N8N_TRIGGER_TIMEOUT_MS = 10_000;
export const N8N_PAGE_TIMEOUT_MS = 30_000;
export const N8N_BODY_CAP_BYTES = 5_000_000;
export const N8N_PAGE_SIZE = 100;
export const N8N_MAX_PAGES = 10;

const portOf = (u: URL): string => u.port || (u.protocol === "https:" ? "443" : "80");

/** Is `url` on the host:port of the configured n8n `baseUrl`? */
export function isN8nHost(url: URL, n8n: N8nSettings): boolean {
  let base: URL;
  try {
    base = new URL(n8n.baseUrl);
  } catch {
    return false;
  }
  return hostnameOf(url) === hostnameOf(base) && portOf(url) === portOf(base);
}

export type N8nTarget = { ok: true; url: URL; addresses: string[] } | { ok: false; reason: string };

/**
 * Is `raw` an acceptable target for an outbound n8n call (API or step webhook)?
 *
 * The configured `baseUrl` host:port is exempt from the private-address block, so an n8n on
 * loopback or a LAN works without further settings; the exemption covers that exact host:port
 * only (API and webhooks), and the connection is still pinned to the addresses the name resolved
 * to. Boof's own server is refused everywhere. Any other host (a `webhookBaseUrl` elsewhere)
 * gets the full webhook check and needs `security.allowedPrivateWebhookHosts` when private.
 */
export async function checkN8nTarget(
  raw: string,
  n8n: N8nSettings,
  allowedPrivateHosts: readonly string[],
  opts: Pick<N8nClientOptions, "resolveHost" | "isSelfUrl">,
): Promise<N8nTarget> {
  let url: URL;
  try {
    url = assertWebhookUrl(raw, opts.isSelfUrl);
  } catch (err) {
    return { ok: false, reason: err instanceof OpError ? err.message : "invalid URL" };
  }
  if (!isN8nHost(url, n8n)) {
    const checked = await checkWebhookTarget(raw, {
      isSelf: opts.isSelfUrl,
      resolve: opts.resolveHost,
      allowedPrivateHosts,
    });
    return checked.ok ? { ok: true, url: checked.url, addresses: checked.addresses } : checked;
  }
  const host = hostnameOf(url);
  if (net.isIP(host)) return { ok: true, url, addresses: [host] };
  let addresses: string[];
  try {
    addresses = await (opts.resolveHost ?? defaultResolve)(host);
  } catch (err) {
    return {
      ok: false,
      reason: `${host} does not resolve (${(err as { code?: string }).code ?? "error"})`,
    };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} does not resolve (no address)` };
  return { ok: true, url, addresses };
}

/** Short, path-free reason for an audit line from a result reason. */
export const auditReason = (reason: string): string =>
  reason.startsWith("blocked")
    ? "blocked"
    : reason.startsWith("n8n answered 404")
      ? "HTTP 404"
      : reason;

export function auditN8n(
  opts: N8nClientOptions,
  action: "n8n:workflows.list" | "n8n:trigger",
  start: number,
  result: { ok: boolean; reason?: string },
  extra: Record<string, string | number | boolean>,
): Promise<void> {
  const via = opts.via ?? "server";
  return auditOperation(opts.root, {
    principal: { id: via, kind: via },
    action,
    via,
    ok: result.ok,
    ...(result.ok ? {} : { code: "upstream_failed" }),
    ms: Date.now() - start,
    at: start,
    // `project` is a core audit key; the rest go to `extra`.
    ...(typeof extra.project === "string" ? { project: extra.project } : {}),
    extra: {
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "project")),
      ...(result.ok || !result.reason ? {} : { reason: auditReason(result.reason) }),
    },
  });
}

class Upstream extends Error {
  constructor(
    public readonly reason: string,
    public readonly httpStatus?: number,
  ) {
    super(reason);
  }
}

export class N8nClient {
  constructor(private readonly opts: N8nClientOptions) {}

  private async config(): Promise<{ n8n: N8nSettings; allowed: string[] }> {
    const settings = await new SettingsStore(this.opts.root).load();
    if (!settings.n8n) {
      throw new OpError(409, "n8n is not configured", "n8n_not_configured");
    }
    return { n8n: settings.n8n, allowed: securitySettings(settings).allowedPrivateWebhookHosts };
  }

  /** One page of the API: the parsed body, or an `Upstream` failure with a short reason. */
  private async page(
    n8n: N8nSettings,
    allowed: string[],
    apiKey: string,
    cursor: string | null,
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    const query = `limit=${N8N_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const target = await checkN8nTarget(
      `${joinUrl(n8n.baseUrl, "api/v1/workflows")}?${query}`,
      n8n,
      allowed,
      this.opts,
    );
    if (!target.ok) throw new Upstream(`blocked: ${target.reason}`);
    let res: { status: number; body: string };
    try {
      res = await (this.opts.request ?? pinnedRequest)(target.url.href, target.addresses, {
        method: "GET",
        headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json", "User-Agent": "boof-n8n" },
        signal: AbortSignal.timeout(this.opts.timeouts?.pageMs ?? N8N_PAGE_TIMEOUT_MS),
        maxResponseBytes: N8N_BODY_CAP_BYTES,
      });
    } catch (err) {
      throw new Upstream(
        err instanceof Error && err.message === "response too large"
          ? "bad_response"
          : "unreachable",
      );
    }
    if (res.status >= 300 && res.status < 400) throw new Upstream("redirected", res.status);
    if (res.status === 401 || res.status === 403) throw new Upstream("unauthorized", res.status);
    if (res.status < 200 || res.status >= 300) throw new Upstream(`HTTP ${res.status}`, res.status);
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Upstream("bad_response", res.status);
    }
    const body = json as { data?: unknown; nextCursor?: unknown } | null;
    if (!body || typeof body !== "object" || !Array.isArray(body.data))
      throw new Upstream("bad_response", res.status);
    const next = typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
    return { data: body.data, nextCursor: next };
  }

  /**
   * GET <baseUrl>/api/v1/workflows?limit=100[&cursor=…], following nextCursor; at most 10 pages.
   * Throws OpError 409 `n8n_not_configured`, or 502 `upstream_failed` with `details.reason`.
   */
  async listWorkflows(): Promise<N8nWorkflowSummary[]> {
    const { n8n, allowed } = await this.config();
    const start = Date.now();
    const host = new URL(n8n.baseUrl).host;
    let lastStatus: number | undefined;
    let pages = 0;
    try {
      const apiKey = await new N8nSecretStore(
        this.opts.root,
        this.opts.env ?? process.env,
      ).getApiKey();
      if (!apiKey) throw new Upstream("unauthorized");
      const workflows: N8nWorkflowSummary[] = [];
      let cursor: string | null = null;
      do {
        if (pages >= N8N_MAX_PAGES) throw new Upstream("too_many");
        const got: { data: unknown[]; nextCursor: string | null } = await this.page(
          n8n,
          allowed,
          apiKey,
          cursor,
        );
        pages++;
        for (const raw of got.data) {
          const summary = summarizeWorkflow(raw, n8n);
          if (summary) workflows.push(summary);
        }
        if (workflows.length > N8N_MAX_PAGES * N8N_PAGE_SIZE) throw new Upstream("too_many");
        cursor = got.nextCursor;
      } while (cursor);
      await auditN8n(this.opts, "n8n:workflows.list", start, { ok: true }, { host, pages });
      return workflows;
    } catch (err) {
      if (!(err instanceof Upstream)) throw err;
      lastStatus = err.httpStatus;
      await auditN8n(
        this.opts,
        "n8n:workflows.list",
        start,
        { ok: false, reason: err.reason },
        { host, pages, ...(lastStatus ? { httpStatus: lastStatus } : {}) },
      );
      throw new OpError(502, `n8n request failed: ${err.reason}`, "upstream_failed", {
        reason: err.reason,
      });
    }
  }

  /** listWorkflows, then the cache. On failure the cache keeps its list, gets lastError, and the error is rethrown. */
  async refresh(): Promise<N8nWorkflowCache> {
    let workflows: N8nWorkflowSummary[];
    try {
      workflows = await this.listWorkflows();
    } catch (err) {
      if (err instanceof OpError && err.code === "upstream_failed") {
        const cache = await readWorkflowCache(this.opts.root);
        await writeWorkflowCache(this.opts.root, { ...cache, lastError: err.message });
      }
      throw err;
    }
    const cache: N8nWorkflowCache = { fetchedAt: new Date().toISOString(), workflows };
    await writeWorkflowCache(this.opts.root, cache);
    return cache;
  }
}
