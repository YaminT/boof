import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, dataRootPaths, defaultSettings, SettingsStore } from "@boof-runner/shared";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

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

async function setup(mode: "required" | "local-trust", mcp?: { enabled: boolean }) {
  const settings = defaultSettings();
  settings.security = {
    allowedHosts: [],
    auth: { mode },
    allowedProjectRoots: [],
    externalTasksRequireApproval: true,
    rateLimit: { perMinute: 600, attachmentsPerMinute: 30 },
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
  app = createApp({ service: new TaskService(root), authStore, peerAddress: () => "10.0.0.7" });
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
  });

  it("accepts a loopback Origin and an allowed-host Origin", async () => {
    expect((await post(INIT, { origin: "http://localhost:4319" })).status).toBe(200);
    const withHost = createApp({
      service: new TaskService(root),
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
    expect(initBody.result.capabilities.tools).toBeDefined();

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
      service: new TaskService(root),
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
});
