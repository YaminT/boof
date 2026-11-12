import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MockTool, ToolRegistry } from "@boof/runner";
import { defaultSettings, SettingsStore } from "@boof/heart";
import { TaskService } from "../api/index.js";
import type { ConciergeMcpServer } from "../concierge/bridge.js";
import { createApp } from "./app.js";
import { conciergeBridgeUrl } from "./server.js";

let root: string;
let service: TaskService;
let peer: string | undefined;
let app: ReturnType<typeof createApp>;

const pingServer = () => {
  const server = new McpServer({ name: "t", version: "1" });
  server.registerTool(
    "ping",
    { description: "ping", inputSchema: { word: z.string() } },
    async ({ word }) => ({ content: [{ type: "text" as const, text: `pong ${word}` }] }),
  );
  return server as unknown as ConciergeMcpServer;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-concierge-route-"));
  await new SettingsStore(root).save(defaultSettings());
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  peer = "127.0.0.1";
  app = createApp({ service, peerAddress: () => peer });
  service.concierge().bridge.setBaseUrl("http://127.0.0.1:4319");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const call = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "ping", arguments: { word: "x" } },
};

function post(
  url: string,
  token: string | undefined,
  body: unknown = call,
  extra: Record<string, string> = {},
) {
  return app.request(new URL(url).pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: "127.0.0.1:4319",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /mcp/concierge/:turnId", () => {
  it("serves the turn's tools to the holder of its token", async () => {
    const lease = service.concierge().bridge.open(pingServer);
    const res = await post(lease.url, lease.token);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("pong x");
    // A second request of the same turn works too (a fresh server per request).
    expect((await post(lease.url, lease.token)).status).toBe(200);
  });

  it.each([
    ["no token", undefined],
    ["a wrong token", "0".repeat(64)],
    ["a malformed token", "short"],
  ])("answers 401 for %s", async (_name, token) => {
    const lease = service.concierge().bridge.open(pingServer);
    expect((await post(lease.url, token)).status).toBe(401);
  });

  it("answers 401 for another turn's id, even with a valid token of a live turn", async () => {
    const bridge = service.concierge().bridge;
    const first = bridge.open(pingServer);
    const second = bridge.open(pingServer);
    expect((await post(second.url, first.token)).status).toBe(401);
    expect((await post(first.url.replace(/[^/]+$/, "nope"), first.token)).status).toBe(401);
  });

  it("refuses the token once the turn is over", async () => {
    const lease = service.concierge().bridge.open(pingServer);
    expect((await post(lease.url, lease.token)).status).toBe(200);
    const other = service.concierge().bridge.open(pingServer);
    lease.close();
    expect((await post(lease.url, lease.token)).status).toBe(401);
    other.close();
    // With no turn open at all the route is not there.
    expect((await post(lease.url, lease.token)).status).toBe(404);
  });

  it("answers only a direct loopback peer", async () => {
    const lease = service.concierge().bridge.open(pingServer);
    peer = "192.168.1.20";
    expect((await post(lease.url, lease.token)).status).toBe(403);
    peer = undefined;
    expect((await post(lease.url, lease.token)).status).toBe(403);
    peer = "127.0.0.1";
    expect(
      (await post(lease.url, lease.token, call, { "x-forwarded-for": "8.8.8.8" })).status,
    ).toBe(403);
    expect((await post(lease.url, lease.token)).status).toBe(200);
  });

  it("refuses other methods and bad bodies", async () => {
    const lease = service.concierge().bridge.open(pingServer);
    const path = new URL(lease.url).pathname;
    const get = await app.request(path, {
      method: "GET",
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(get.status).toBe(405);
    expect((await post(lease.url, lease.token, "{nope")).status).toBe(400);
    expect((await post(lease.url, lease.token, [call])).status).toBe(400);
  });
});

describe("conciergeBridgeUrl", () => {
  it.each([
    ["127.0.0.1", false, "http://127.0.0.1:4319"],
    ["localhost", false, "http://127.0.0.1:4319"],
    ["::1", false, "http://[::1]:4319"],
    ["0.0.0.0", false, "http://127.0.0.1:4319"],
    ["::", false, "http://127.0.0.1:4319"],
    ["100.64.0.7", false, null],
    ["example.com", false, null],
    ["127.0.0.1", true, null],
  ])("%s tls=%s -> %s", (host, tls, expected) => {
    expect(conciergeBridgeUrl(host, 4319, tls)).toBe(expected);
  });
});
