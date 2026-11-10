import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  N8nSecretStore,
  N8nSettingsSchema,
  SettingsStore,
  type ExternalTriggerRequest,
} from "@boof/heart";
import {
  fakeWorkflow,
  notSelf,
  serverSelfCheck,
  startFakeN8n,
} from "../../test-support/fake-n8n.js";
import { OpError } from "../api/errors.js";
import { N8nClient, checkN8nTarget } from "./client.js";
import { createN8nTransport } from "./transport.js";
import { readWorkflowCache } from "./workflows.js";
import type { pinnedRequest } from "../server/pinned-post.js";

let root: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-n8n-client-"));
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const KEY = "n8n_api_KEY_secret_value";

async function configure(
  n8n: Record<string, unknown> | null,
  allowed: string[] = [],
  key: string | null = KEY,
): Promise<void> {
  const settings = defaultSettings();
  await new SettingsStore(root).save({
    ...settings,
    ...(allowed.length
      ? { security: { ...settings.security, allowedPrivateWebhookHosts: allowed } }
      : {}),
    ...(n8n
      ? { n8n: N8nSettingsSchema.parse({ callbackBaseUrl: "https://boof.example/boof", ...n8n }) }
      : {}),
  });
  if (key) await new N8nSecretStore(root, {}).setApiKey(key);
}

async function fake(workflows: unknown[] = [], pageSize?: number) {
  const f = await startFakeN8n({ apiKey: KEY, workflows, pageSize });
  closers.push(f.close);
  return f;
}

const client = (extra: Partial<ConstructorParameters<typeof N8nClient>[0]> = {}) =>
  new N8nClient({ root, env: {}, isSelfUrl: notSelf, ...extra });

const manyWorkflows = (n: number) =>
  Array.from({ length: n }, (_, i) => fakeWorkflow({ id: `w${i}`, name: `W ${i}` }));

async function failure(p: Promise<unknown>): Promise<OpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err as OpError;
  }
  throw new Error("expected a failure");
}

describe("N8nClient.listWorkflows", () => {
  it("lists 250 workflows over 3 pages with X-N8N-API-KEY and limit=100", async () => {
    const f = await fake(manyWorkflows(250));
    await configure({ baseUrl: f.url });
    const list = await client().listWorkflows();
    expect(list).toHaveLength(250);
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) {
      expect(c.headers["x-n8n-api-key"]).toBe(KEY);
      expect(c.path).toContain("limit=100");
    }
    expect(f.calls[0]!.path).not.toContain("cursor");
    expect(f.calls[1]!.path).toContain("cursor=100");
  });

  it("1001 workflows → 502 upstream_failed too_many; exactly 1000 is fine", async () => {
    const f = await fake(manyWorkflows(1001));
    await configure({ baseUrl: f.url });
    const err = await failure(client().listWorkflows());
    expect([err.status, err.code, err.details]).toEqual([
      502,
      "upstream_failed",
      { reason: "too_many" },
    ]);
    const g = await fake(manyWorkflows(1000));
    await configure({ baseUrl: g.url });
    expect(await client().listWorkflows()).toHaveLength(1000);
  });

  it("summaries: POST webhook usable, GET not, disabled node skipped, no webhook → [], editorUrl", async () => {
    const odd = {
      ...(fakeWorkflow({ id: "multi", name: "Two" }) as object),
      nodes: [
        { type: "n8n-nodes-base.webhook", parameters: { path: "a", httpMethod: "POST" } },
        { type: "n8n-nodes-base.webhook", parameters: { path: "b", httpMethod: "POST" } },
        {
          type: "n8n-nodes-base.webhook",
          disabled: true,
          parameters: { path: "c", httpMethod: "POST" },
        },
      ],
    };
    const f = await fake([
      fakeWorkflow({ id: "post", name: "P", webhook: { path: "abc-123" } }),
      fakeWorkflow({ id: "get", name: "G", webhook: { path: "g", method: "GET" } }),
      fakeWorkflow({ id: "none", name: "N", webhook: null, active: false }),
      odd,
      { nonsense: true },
    ]);
    await configure({ baseUrl: `${f.url}/` });
    const list = await client().listWorkflows();
    expect(list.map((w) => w.id)).toEqual(["post", "get", "none", "multi"]);
    expect(list[0]).toMatchObject({
      name: "P",
      active: true,
      webhooks: [{ path: "abc-123", method: "POST", usable: true }],
      editorUrl: `${f.url}/workflow/post`,
    });
    expect(list[1]!.webhooks).toEqual([{ path: "g", method: "GET", usable: false }]);
    expect(list[2]).toMatchObject({ webhooks: [], active: false });
    expect(list[3]!.webhooks).toEqual([
      { path: "a", method: "POST", usable: false },
      { path: "b", method: "POST", usable: false },
    ]);
  });

  it("wrong key → 502 unauthorized; the cache keeps its list and records lastError", async () => {
    const f = await fake([fakeWorkflow({ id: "a", name: "A" })]);
    await configure({ baseUrl: f.url });
    const ok = await client().refresh();
    expect(ok.workflows).toHaveLength(1);
    expect((await readWorkflowCache(root)).fetchedAt).toBe(ok.fetchedAt);
    await new N8nSecretStore(root, {}).setApiKey("wrong-key");
    const err = await failure(client().refresh());
    expect([err.status, err.details]).toEqual([502, { reason: "unauthorized" }]);
    const cache = await readWorkflowCache(root);
    expect(cache.workflows.map((w) => w.id)).toEqual(["a"]);
    expect(cache.fetchedAt).toBe(ok.fetchedAt);
    expect(cache.lastError).toMatch(/unauthorized/);
  });

  it("not configured → 409 n8n_not_configured and no request", async () => {
    const f = await fake([]);
    await configure(null);
    const request = vi.fn();
    const err = await failure(
      client({ request: request as unknown as typeof pinnedRequest }).listWorkflows(),
    );
    expect([err.status, err.code]).toEqual([409, "n8n_not_configured"]);
    expect(request).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    expect(await readWorkflowCache(root)).toEqual({ fetchedAt: null, workflows: [] });
  });

  it("no API key → unauthorized without a request", async () => {
    const f = await fake([]);
    await configure({ baseUrl: f.url }, [], null);
    const err = await failure(client().listWorkflows());
    expect(err.details).toEqual({ reason: "unauthorized" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("outbound target rules (owner answer 2)", () => {
  const n8n = (baseUrl: string, extra: Record<string, unknown> = {}) =>
    N8nSettingsSchema.parse({ baseUrl, callbackBaseUrl: "https://boof.example", ...extra });

  it("O1: the configured loopback base is exempt without any allowlist entry", async () => {
    const f = await fake([fakeWorkflow({ id: "a", name: "A" })]);
    await configure({ baseUrl: f.url }, []);
    expect(await client().listWorkflows()).toHaveLength(1);
  });

  it("the exemption covers the base host:port only: another port or host still needs the allowlist", async () => {
    const s = n8n("http://127.0.0.1:5678");
    const same = await checkN8nTarget("http://127.0.0.1:5678/webhook/x", s, [], {
      isSelfUrl: notSelf,
    });
    expect(same).toMatchObject({ ok: true, addresses: ["127.0.0.1"] });
    for (const raw of [
      "http://127.0.0.1:5679/webhook/x",
      "http://127.0.0.2:5678/webhook/x",
      "http://localhost:5678/webhook/x",
      "http://[::1]:5678/webhook/x",
    ]) {
      const r = await checkN8nTarget(raw, s, [], { isSelfUrl: notSelf });
      expect(r.ok, raw).toBe(false);
    }
    // an explicit allowlist entry still works for those, as for any webhook
    expect(
      await checkN8nTarget("http://127.0.0.1:5679/webhook/x", s, ["127.0.0.1"], {
        isSelfUrl: notSelf,
      }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("changing baseUrl drops the old exemption", async () => {
    const before = n8n("http://127.0.0.1:5678");
    const after = n8n("http://127.0.0.1:6000");
    const url = "http://127.0.0.1:5678/webhook/x";
    expect((await checkN8nTarget(url, before, [], { isSelfUrl: notSelf })).ok).toBe(true);
    expect((await checkN8nTarget(url, after, [], { isSelfUrl: notSelf })).ok).toBe(false);
  });

  it("boof's own server address is refused even on the exempt host:port", async () => {
    const s = n8n("http://127.0.0.1:8123");
    const isSelfUrl = serverSelfCheck(8123);
    const r = await checkN8nTarget("http://127.0.0.1:8123/api/v1/workflows", s, [], { isSelfUrl });
    expect(r).toMatchObject({ ok: false });
    // through the client it is a "blocked" upstream failure and nothing was sent
    const request = vi.fn();
    await configure({ baseUrl: "http://127.0.0.1:8123" });
    const err = await failure(
      client({ isSelfUrl, request: request as unknown as typeof pinnedRequest }).listWorkflows(),
    );
    expect(err.details).toMatchObject({ reason: expect.stringMatching(/^blocked: /) });
    expect(request).not.toHaveBeenCalled();
  });

  describe("F1: boof itself is refused on the exempt host:port, judged on resolved addresses", () => {
    let boof: Server;
    let port: number;
    let hits: string[];
    beforeEach(async () => {
      hits = [];
      boof = createServer((req, res) => {
        hits.push(`${req.method} ${req.url} key=${String(req.headers["x-n8n-api-key"])}`);
        res.end("{}");
      });
      await new Promise<void>((r) => boof.listen(0, "127.0.0.1", r));
      port = (boof.address() as AddressInfo).port;
      closers.push(() => new Promise<void>((r) => boof.close(() => r())));
    });

    it("[::ffff:127.0.0.1] on boof's port is refused by the settings schema (not canonical: the URL parser rewrites it)", () => {
      const parsed = N8nSettingsSchema.safeParse({
        baseUrl: `http://[::ffff:127.0.0.1]:${port}`,
        callbackBaseUrl: "https://boof.example",
      });
      expect(parsed.success).toBe(false);
    });

    // Canonical names only: the resolved-address self check is what refuses these.
    const cases: [string, string[] | null, string][] = [
      ["localhost.", null, "127.0.0.1"],
      ["myself.example", ["127.0.0.1"], "127.0.0.1"],
      ["127.0.0.2", null, "127.0.0.1"],
      ["[::]", null, "0.0.0.0"],
      ["0.0.0.0", null, "0.0.0.0"],
      ["lan-alias.example", ["::ffff:127.0.0.1"], "127.0.0.1"],
    ];
    for (const [host, resolved, bind] of cases) {
      it(`${host} on boof's port (bound ${bind}): refused, nothing sent, no key leaves`, async () => {
        const isSelfUrl = serverSelfCheck(port, bind);
        const resolveHost = async (h: string) => resolved ?? [h === "localhost." ? "127.0.0.1" : h];
        const base = `http://${host}:${port}`;
        const s = n8n(base);
        const r = await checkN8nTarget(`${base}/api/v1/workflows`, s, [], {
          isSelfUrl,
          resolveHost,
        });
        expect(r.ok, host).toBe(false);
        await configure({ baseUrl: base });
        const err = await failure(client({ isSelfUrl, resolveHost }).listWorkflows());
        expect(err.details).toMatchObject({ reason: expect.stringMatching(/^blocked: /) });
        expect(hits).toEqual([]);
      });
    }

    it("a real local n8n on another port still works", async () => {
      const f = await fake([fakeWorkflow({ id: "a", name: "A" })]);
      await configure({ baseUrl: f.url });
      const list = await client({ isSelfUrl: serverSelfCheck(port) }).listWorkflows();
      expect(list).toHaveLength(1);
    });
  });

  describe("F2: the exemption never reaches link-local, multicast, unspecified or reserved", () => {
    const s = n8n("http://n8n.lan:5678");
    const blocked: [string, string][] = [
      ["169.254.169.254", "link-local"],
      ["169.254.0.1", "link-local"],
      ["fe80::1", "link-local"],
      ["224.0.0.1", "multicast"],
      ["ff02::1", "multicast"],
      ["0.0.0.0", "unspecified"],
      ["0.1.2.3", "unspecified"],
      ["::", "unspecified"],
      ["255.255.255.255", "reserved"],
      ["240.0.0.1", "reserved"],
      ["198.18.0.1", "reserved"],
    ];
    for (const [address, range] of blocked) {
      it(`${address} (${range}) is refused for a name and as a literal`, async () => {
        const resolveHost = async () => [address];
        const named = await checkN8nTarget("http://n8n.lan:5678/x", s, [], {
          resolveHost,
          isSelfUrl: notSelf,
        });
        expect(named).toMatchObject({ ok: false, reason: expect.stringContaining(range) });
        const lit = address.includes(":") ? `[${address}]` : address;
        const literal = await checkN8nTarget(
          `http://${lit}:5678/x`,
          n8n(`http://${lit}:5678`),
          [],
          { isSelfUrl: notSelf },
        );
        expect(literal.ok, address).toBe(false);
      });
    }
    for (const address of [
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.5",
      "fd00::5",
      "127.0.0.1",
      "::1",
    ]) {
      it(`${address} stays exempt`, async () => {
        const r = await checkN8nTarget("http://n8n.lan:5678/x", s, [], {
          resolveHost: async () => [address],
          isSelfUrl: notSelf,
        });
        expect(r).toMatchObject({ ok: true, addresses: [address] });
      });
    }
    it("one bad address among good ones refuses the name", async () => {
      const r = await checkN8nTarget("http://n8n.lan:5678/x", s, [], {
        resolveHost: async () => ["10.0.0.5", "169.254.169.254"],
        isSelfUrl: notSelf,
      });
      expect(r.ok).toBe(false);
    });
  });

  it("O2: a name resolving to 10.0.0.5 is exempt as the base (pinned to it) but blocked as another host", async () => {
    const resolveHost = vi.fn(async () => ["10.0.0.5"]);
    const s = n8n("http://n8n.lan:5678", { webhookBaseUrl: "http://hooks.lan:5678/webhook" });
    expect(
      await checkN8nTarget("http://n8n.lan:5678/webhook/x", s, [], {
        resolveHost,
        isSelfUrl: notSelf,
      }),
    ).toMatchObject({
      ok: true,
      addresses: ["10.0.0.5"],
    });
    const other = await checkN8nTarget("http://hooks.lan:5678/webhook/x", s, [], {
      resolveHost,
      isSelfUrl: notSelf,
    });
    expect(other).toMatchObject({
      ok: false,
      reason: expect.stringContaining("10.0.0.5 is private"),
    });
  });

  it("O3: the request seam receives the checked addresses and the name is resolved once", async () => {
    const resolveHost = vi.fn(async () => ["93.184.216.34"]);
    const request = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: [], nextCursor: null }),
    }));
    await configure({ baseUrl: "http://n8n.example.test:5678" });
    await client({
      resolveHost,
      request: request as unknown as typeof pinnedRequest,
    }).listWorkflows();
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, addresses] = request.mock.calls[0] as unknown as [string, string[]];
    expect(url).toMatch(/^http:\/\/n8n\.example\.test:5678\/api\/v1\/workflows\?/);
    expect(addresses).toEqual(["93.184.216.34"]);
  });

  it("O4: a 302 from n8n → redirected, Location not requested", async () => {
    const request = vi.fn(async () => ({ status: 302, body: "" }));
    await configure({ baseUrl: "http://127.0.0.1:5678" });
    // The request is stubbed and nothing is listening. Skip the Linux uid check.
    const err = await failure(
      client({
        request: request as unknown as typeof pinnedRequest,
        listener: { platform: "darwin" },
      }).listWorkflows(),
    );
    expect(err.details).toEqual({ reason: "redirected" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("O5: the API key goes only to baseUrl's origin; the webhook gets X-Boof-Token only", async () => {
    const api = await fake([fakeWorkflow({ id: "a", name: "A" })]);
    const hooks = await fake();
    await configure(
      { baseUrl: api.url, webhookBaseUrl: `${hooks.url}/webhook` },
      ["127.0.0.1"], // the webhook host is not the n8n host:port
    );
    const secret = await new N8nSecretStore(root, {}).rotateWebhookSecret();
    await client().listWorkflows();
    const transport = createN8nTransport({
      root,
      env: {},
      isSelfUrl: notSelf,
      serverRunning: async () => true,
    });
    const res = await transport.trigger(triggerRequest());
    expect(res).toEqual({ ok: true, sent: "answered" });
    expect(api.calls.every((c) => c.headers["x-boof-token"] === undefined)).toBe(true);
    expect(api.calls.every((c) => c.headers["x-n8n-api-key"] === KEY)).toBe(true);
    expect(hooks.calls).toHaveLength(1);
    expect(hooks.calls[0]!.headers["x-boof-token"]).toBe(secret);
    expect(hooks.calls[0]!.headers["x-n8n-api-key"]).toBeUndefined();
    expect(hooks.calls[0]!.path).toBe("/webhook/hook-path-1234");
  });

  it("webhook hosts other than the base still need the allowlist", async () => {
    const api = await fake();
    const hooks = await fake();
    await configure({ baseUrl: api.url, webhookBaseUrl: `${hooks.url}/webhook` }, []);
    const transport = createN8nTransport({
      root,
      env: {},
      isSelfUrl: notSelf,
      serverRunning: async () => true,
    });
    const res = await transport.trigger(triggerRequest());
    expect(res).toMatchObject({
      ok: false,
      retryable: false,
      reason: expect.stringMatching(/^blocked: /),
    });
    expect(hooks.calls).toHaveLength(0);
  });

  it("O6: no key, webhook secret or run token in errors, audit lines, console output or results", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const f = await startFakeN8n({
      apiKey: KEY,
      workflows: [fakeWorkflow({ id: "a", name: "A" })],
      onWebhook: (c) => ({ status: c.path.includes("boom") ? 503 : 200 }),
    });
    closers.push(f.close);
    await configure({ baseUrl: f.url });
    const secret = await new N8nSecretStore(root, {}).rotateWebhookSecret();
    const out: unknown[] = [];
    const transport = createN8nTransport({
      root,
      env: {},
      isSelfUrl: notSelf,
      serverRunning: async () => true,
    });
    out.push(await client().listWorkflows());
    out.push(await transport.trigger(triggerRequest()));
    out.push(await transport.trigger(triggerRequest({ webhookPath: "boom-path-99" })));
    out.push(
      await transport.trigger(triggerRequest({ webhookPath: "missing-path" })).catch((e) => e),
    );
    await new N8nSecretStore(root, {}).setApiKey("wrong");
    out.push((await failure(client().refresh())).toBody());
    const audit = (
      await Promise.all(
        (await readdir(join(root, "audit"))).map((n) => readFile(join(root, "audit", n), "utf8")),
      )
    ).join("");
    expect(audit).toContain("n8n:trigger");
    const all = JSON.stringify(out) + audit + JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secretText of [KEY, "wrong", secret, "bxs_RUNTOKEN_secret_value"]) {
      expect(all).not.toContain(secretText);
    }
    expect(audit).not.toContain("hook-path-1234");
    expect(audit).not.toContain("boom-path-99");
  });

  it("O7: a page that never answers aborts at the page timeout", async () => {
    const hang: Server = createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    closers.push(
      () =>
        new Promise<void>((r) => {
          hang.closeAllConnections();
          hang.close(() => r());
        }),
    );
    await configure({ baseUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}` });
    // The page timeout is the only way out of a server that never answers; no wall-clock bound.
    const err = await failure(client({ timeouts: { pageMs: 150 } }).listWorkflows());
    expect(err.details).toEqual({ reason: "unreachable" });
  });

  it("O8: a body over 5 MB → bad_response, and the stream is aborted", async () => {
    let closedEarly = false;
    const big: Server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = "x".repeat(1_000_000);
      let sent = 0;
      const pump = () => {
        while (sent < 50) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => {
        if (sent < 50) closedEarly = true;
      });
      pump();
    });
    await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
    closers.push(
      () =>
        new Promise<void>((r) => {
          big.closeAllConnections();
          big.close(() => r());
        }),
    );
    await configure({ baseUrl: `http://127.0.0.1:${(big.address() as AddressInfo).port}` });
    const err = await failure(client().listWorkflows());
    expect(err.details).toEqual({ reason: "bad_response" });
    expect(closedEarly).toBe(true);
  });

  it("a non-JSON or wrongly shaped 200 → bad_response; other statuses → HTTP <n>", async () => {
    await configure({ baseUrl: "http://127.0.0.1:5678" });
    // The request is stubbed and nothing is listening. Skip the Linux uid check.
    const answer = (status: number, body: string) =>
      client({
        request: (async () => ({ status, body })) as unknown as typeof pinnedRequest,
        listener: { platform: "darwin" },
      }).listWorkflows();
    expect((await failure(answer(200, "<html>"))).details).toEqual({ reason: "bad_response" });
    expect((await failure(answer(200, '{"data":"x"}'))).details).toEqual({
      reason: "bad_response",
    });
    expect((await failure(answer(500, "{}"))).details).toEqual({ reason: "HTTP 500" });
    expect((await failure(answer(403, "{}"))).details).toEqual({ reason: "unauthorized" });
  });

  it("does not send the API key when another uid holds the loopback port", async () => {
    const request = vi.fn(async () => ({ status: 200, body: '{"data":[]}' }));
    await configure({ baseUrl: "http://127.0.0.1:5678" });
    const portHex = (5678).toString(16).toUpperCase().padStart(4, "0");
    const head =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const row = `   0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1001 0 1 1 0000000000000000 100 0 0 10 0\n`;
    const err = await failure(
      client({
        request: request as unknown as typeof pinnedRequest,
        listener: {
          platform: "linux",
          endian: "LE",
          uid: 1000,
          readFile: (path) => (path === "/proc/net/tcp" ? head + row : head),
        },
      }).listWorkflows(),
    );
    expect(err.details).toMatchObject({
      reason: expect.stringMatching(/listener_not_owner:.*uid 1001/),
    });
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(request).not.toHaveBeenCalled();
  });

  it("sends when the listener is root, and does not consult proc off Linux", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: [], nextCursor: null }),
    }));
    await configure({ baseUrl: "http://127.0.0.1:5678" });
    const portHex = (5678).toString(16).toUpperCase().padStart(4, "0");
    const head =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const row = `   0: 00000000:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1 0000000000000000 100 0 0 10 0\n`;
    await client({
      request: request as unknown as typeof pinnedRequest,
      listener: {
        platform: "linux",
        endian: "LE",
        uid: 1000,
        readFile: (path) => (path === "/proc/net/tcp" ? head + row : head),
      },
    }).listWorkflows();
    expect(request).toHaveBeenCalledTimes(1);
    const readFile = (): string => {
      throw new Error("proc");
    };
    await client({
      request: request as unknown as typeof pinnedRequest,
      listener: { platform: "win32", readFile },
    }).listWorkflows();
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(request.mock.calls)).toContain(KEY);
  });

  it("writes one audit line per list with the host, outcome and no path or key", async () => {
    const f = await fake(manyWorkflows(150));
    await configure({ baseUrl: f.url });
    await client().listWorkflows();
    const names = await readdir(join(root, "audit"));
    const lines = (await readFile(join(root, "audit", names[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: "n8n:workflows.list",
      via: "server",
      principal: "server",
      outcome: "ok",
      host: new URL(f.url).host,
      pages: 2,
    });
  });
});

function triggerRequest(over: Partial<ExternalTriggerRequest> = {}): ExternalTriggerRequest {
  return {
    projectId: "shop",
    taskId: "fix-login",
    stepId: "ci",
    runId: "xr-" + "a".repeat(32),
    workflowId: "wf1",
    webhookPath: "hook-path-1234",
    signal: new AbortController().signal,
    payload: {
      boof: { version: "0.4.0", kind: "step" },
      run: {
        id: "xr-" + "a".repeat(32),
        callbackUrl: "https://boof.example/callbacks/external-steps/xr-" + "a".repeat(32),
        token: "bxs_RUNTOKEN_secret_value",
        expiresAt: "2026-11-09T12:00:00.000Z",
      },
      step: { id: "ci", label: "CI", at: "after-developer" },
      task: {
        project: "shop",
        id: "fix-login",
        title: "t",
        prompt: "p",
        labels: [],
        priority: 0,
        iteration: 1,
      },
      reports: {},
    },
    ...over,
  };
}
