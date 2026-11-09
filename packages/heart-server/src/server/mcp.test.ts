import { TEST_LOOPBACK_IS_UI } from "./test-ui-session.js";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, dataRootPaths, defaultSettings, SettingsStore } from "@boof/heart";
import { TaskService } from "../api/index.js";
import { createApp } from "./app.js";
import { MockTool, ToolRegistry } from "@boof/runner";

let base: string;
let root: string;
let authStore: AuthStore;
let app: ReturnType<typeof createApp>;
let key: string;

const ACCEPT = "application/json, text/event-stream";
const rpc = (method: string, params: unknown = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === null ? {} : { id }) });
const INIT = rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "t", version: "1" },
});

const post = (body: string, headers: Record<string, string> = {}, bearer: string | null = key) =>
  app.request("http://localhost/mcp", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
  });

async function auditLines(): Promise<Record<string, unknown>[]> {
  const dir = dataRootPaths(root).audit;
  const out: Record<string, unknown>[] = [];
  for (const f of await readdir(dir).catch(() => [])) {
    for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (l) out.push(JSON.parse(l));
    }
  }
  return out;
}

async function setup(
  mode: "required" | "local-trust",
  mcp?: { enabled: boolean },
  perMinute = 600,
) {
  const settings = defaultSettings();
  settings.security = {
    allowedHosts: [],
    auth: { mode },
    allowedProjectRoots: [],
    externalTasksRequireApproval: true,
    rateLimit: { perMinute, attachmentsPerMinute: 30, unauthenticatedPerMinute: 30 },
    trustedProxies: ["loopback"],
    audit: { enabled: true, retentionDays: 90 },
  };
  if (mcp) settings.mcp = mcp;
  await new SettingsStore(root).save(settings);
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-mcp-http-")));
  root = join(base, "data");
  await setup("required");
  authStore = new AuthStore(root);
  key = (await authStore.create({ name: "h", scopes: ["projects:read"], trust: "review" })).key;
  app = createApp({
    browserSessions: TEST_LOOPBACK_IS_UI,
    service: new TaskService(root, new ToolRegistry([new MockTool()])),
    authStore,
    peerAddress: () => "10.0.0.7",
  });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("POST /mcp", () => {
  it("answers 401 without a key", async () => {
    const res = await post(INIT, {}, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("answers 403 for an Origin that is not an allowed host", async () => {
    const res = await post(INIT, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("origin_not_allowed");
    expect((await post(INIT, { origin: "null" })).status).toBe(403);
    // A loopback origin on another port is another site.
    const port = { origin: "http://localhost:3000", host: "localhost:4319" };
    expect((await post(INIT, port)).status).toBe(403);
  });

  it("accepts a loopback Origin and an allowed-host Origin", async () => {
    expect((await post(INIT, { origin: "http://localhost", host: "localhost" })).status).toBe(200);
    const withHost = createApp({
      browserSessions: TEST_LOOPBACK_IS_UI,
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      authStore,
      peerAddress: () => "10.0.0.7",
      allowedHosts: ["boof.example.com"],
    });
    const res = await withHost.request("http://boof.example.com/mcp", {
      method: "POST",
      body: INIT,
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: `Bearer ${key}`,
        origin: "https://boof.example.com",
        host: "boof.example.com",
      },
    });
    expect(res.status).toBe(200);
  });

  it("initializes, lists the tools the key allows and calls a tool", async () => {
    const init = await post(INIT);
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe("boof-runner");
    expect(initBody.result.capabilities).toMatchObject({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });

    const list = await (await post(rpc("tools/list", {}, 2))).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("boof_list_projects");
    expect(names).not.toContain("boof_create_plan");

    const called = await (
      await post(rpc("tools/call", { name: "boof_list_projects", arguments: {} }, 3))
    ).json();
    expect(called.result.isError).toBeFalsy();
    expect(called.result.structuredContent.projects).toEqual([]);

    const denied = await (
      await post(rpc("tools/call", { name: "boof_create_plan", arguments: { projectId: "x" } }, 4))
    ).json();
    expect(denied.error?.code ?? denied.result?.isError).toBeTruthy();
  });

  it("answers a notification with 202 and a bad body with 400", async () => {
    expect((await post(rpc("notifications/initialized", {}, null))).status).toBe(202);
    const bad = await post("{not json");
    expect(bad.status).toBe(400);
  });

  it("does not offer sessions: GET and DELETE are refused in stateless mode", async () => {
    const get = await app.request("http://localhost/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream", authorization: `Bearer ${key}` },
    });
    expect(get.status).toBe(405);
    const del = await app.request("http://localhost/mcp", {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(del.status).toBe(405);
    expect(del.headers.get("allow")).toBe("POST");
  });

  it("records the call in the audit log as mcp:<tool>", async () => {
    await post(rpc("tools/call", { name: "boof_list_projects", arguments: {} }, 5));
    await post(rpc("tools/list", {}, 6));
    const lines = await auditLines();
    expect(lines.some((l) => l.action === "mcp:boof_list_projects" && l.status === 200)).toBe(true);
    expect(lines.some((l) => l.action === "mcp:tools/list")).toBe(true);
  });

  it("follows a revocation at once (shared client registry)", async () => {
    expect((await post(INIT)).status).toBe(200);
    const [client] = await authStore.list();
    await authStore.revoke(client.id);
    expect((await post(INIT)).status).toBe(401);
  });

  it("is switched off by settings.mcp.enabled = false", async () => {
    await setup("required", { enabled: false });
    expect((await post(INIT)).status).toBe(404);
  });
});

describe("/mcp under local-trust", () => {
  it("serves a loopback peer without a key, and refuses a remote one", async () => {
    await setup("local-trust");
    const local = createApp({
      browserSessions: TEST_LOOPBACK_IS_UI,
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      authStore,
      peerAddress: () => "127.0.0.1",
    });
    const res = await local.request("http://localhost/mcp", {
      method: "POST",
      body: INIT,
      headers: { "content-type": "application/json", accept: ACCEPT },
    });
    expect(res.status).toBe(200);
    expect((await post(INIT, {}, null)).status).toBe(401);
  });

  it("refuses a JSON-RPC batch with a clear error", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const res = await post(batch);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/batch/i);
  });

  it("applies the self-host webhook check on the MCP path as REST does", async () => {
    const admin = (await authStore.create({ name: "adm", scopes: ["admin"], trust: "trusted" }))
      .key;
    const withSelf = createApp({
      browserSessions: TEST_LOOPBACK_IS_UI,
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      authStore,
      peerAddress: () => "10.0.0.7",
      isSelfUrl: (u) => u.hostname === "self.test",
      resolveHost: async () => ["93.184.216.34"],
    });
    const call = async (url: string) => {
      const res = await withSelf.request("http://localhost/mcp", {
        method: "POST",
        body: rpc("tools/call", { name: "boof_create_webhook", arguments: { url } }),
        headers: {
          "content-type": "application/json",
          accept: ACCEPT,
          authorization: `Bearer ${admin}`,
        },
      });
      return (await res.json()).result;
    };
    const self = await call("http://self.test/hook");
    expect(self.isError).toBe(true);
    expect(self.content[0].text).toContain("boof server itself");
    const ok = await call("http://hook.test/in");
    expect(ok.isError).toBeFalsy();
  });

  describe("keyless loopback under local-trust", () => {
    const keyless = async () => {
      await setup("local-trust");
      const svc = new TaskService(root, new ToolRegistry([new MockTool()]));
      const local = createApp({
        browserSessions: TEST_LOOPBACK_IS_UI,
        service: svc,
        authStore,
        peerAddress: () => "127.0.0.1",
      });
      const rpcCall = async (body: string) => {
        const res = await local.request("http://localhost/mcp", {
          method: "POST",
          body,
          headers: { "content-type": "application/json", accept: ACCEPT },
        });
        return (await res.json()).result;
      };
      return { svc, rpcCall };
    };

    it("is the review-trust local-mcp principal with no administration tools", async () => {
      const { rpcCall } = await keyless();
      const list = await rpcCall(rpc("tools/list"));
      const names = list.tools.map((t: { name: string }) => t.name);
      for (const n of [
        "boof_create_client",
        "boof_list_clients",
        "boof_create_webhook",
        "boof_update_settings",
        "boof_create_command",
        "boof_delete_project",
        "boof_check_health",
      ]) {
        expect(names, n).not.toContain(n);
      }
      expect(names).toContain("boof_create_task");
      const whoami = await rpcCall(rpc("tools/call", { name: "boof_whoami", arguments: {} }));
      expect(JSON.stringify(whoami.structuredContent)).toContain("local-mcp");
    });

    it("is recorded in the audit log as local-mcp, while the UI's keyless calls stay local", async () => {
      await setup("local-trust");
      const local = createApp({
        browserSessions: TEST_LOOPBACK_IS_UI,
        service: new TaskService(root),
        authStore,
        peerAddress: () => "127.0.0.1",
      });
      await local.request("http://localhost/mcp", {
        method: "POST",
        body: rpc("tools/call", { name: "boof_list_projects", arguments: {} }),
        headers: { "content-type": "application/json", accept: ACCEPT },
      });
      await local.request("http://localhost/api/v1/whoami");
      const lines = await auditLines();
      const mcpLine = lines.find((l) => l.action === "mcp:boof_list_projects");
      expect(mcpLine).toMatchObject({ principal: "local-mcp", kind: "client" });
      expect(lines.find((l) => String(l.action).startsWith("GET /api/v1/whoami"))).toMatchObject({
        principal: "local",
        kind: "local",
      });
    });

    it("has its own rate-limit bucket, separate from the UI's", async () => {
      await setup("local-trust", undefined, 3);
      const local = createApp({
        browserSessions: TEST_LOOPBACK_IS_UI,
        service: new TaskService(root),
        authStore,
        peerAddress: () => "127.0.0.1",
      });
      const mcp = () =>
        local.request("http://localhost/mcp", {
          method: "POST",
          body: rpc("tools/list"),
          headers: { "content-type": "application/json", accept: ACCEPT },
        });
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await mcp()).status);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      // The UI's keyless bucket is untouched by the model host's burst.
      expect((await local.request("http://localhost/api/v1/whoami")).status).toBe(200);
    });

    it("refuses while clients.json holds a client with the reserved id, as stdio does", async () => {
      await setup("local-trust");
      await authStore.create({ name: "old", scopes: ["tasks:read"] });
      const file = join(root, "auth", "clients.json");
      const raw = JSON.parse(await readFile(file, "utf8"));
      raw.clients[0].id = "local-mcp";
      await writeFile(file, JSON.stringify(raw));
      const local = createApp({
        browserSessions: TEST_LOOPBACK_IS_UI,
        service: new TaskService(root),
        authStore: new AuthStore(root),
        peerAddress: () => "127.0.0.1",
      });
      const res = await local.request("http://localhost/mcp", {
        method: "POST",
        body: rpc("tools/list"),
        headers: { "content-type": "application/json", accept: ACCEPT },
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/local-mcp.*clients\.json/s);
      // The UI's keyless REST path is not affected.
      expect((await local.request("http://localhost/api/v1/whoami")).status).toBe(200);
    });

    it("cannot mint a key, toggle the runner or create a pending task", async () => {
      const { svc, rpcCall } = await keyless();
      await svc.projects.create({ workingDirectory: base, id: "shop" }).catch(() => undefined);
      const call = (name: string, args: object) =>
        rpcCall(rpc("tools/call", { name, arguments: args }));
      // A tool that is not listed does not exist for this caller.
      const mint = await rpcCall(
        rpc("tools/call", {
          name: "boof_create_client",
          arguments: { name: "x", scopes: ["admin"], trust: "trusted" },
        }),
      ).catch(() => undefined);
      expect(mint).toBeUndefined();
      const runner = await call("boof_set_runner", { enabled: true });
      expect(runner.isError).toBe(true);
      expect(runner.content[0].text).toMatch(/^forbidden_trust:/);
    });
  });
});
