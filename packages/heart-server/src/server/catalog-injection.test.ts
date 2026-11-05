import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore, type CachedHealth, type ToolCatalog } from "@boof/heart";
import { TaskService } from "../api/index.js";
import { createApp } from "./app.js";

// Heart server owns no tools: whatever the composition root injects is what REST (and MCP, which
// reads the same TaskService) serve. A stub that is not a Runner registry proves nothing else is
// constructed behind its back.
const health: CachedHealth = {
  status: "available",
  message: "stub ok",
  checkedAt: "2026-11-02T00:00:00.000Z",
};
function stubCatalog(calls: string[]): ToolCatalog {
  return {
    list: () => [
      {
        id: "stub",
        displayName: "Stub tool",
        defaultModels: ["stub-1"],
        unavailableReason: "desktop unavailable",
      },
    ],
    get: (id) =>
      id === "stub"
        ? {
            id,
            displayName: "Stub tool",
            defaultModels: ["stub-1"],
            unavailableReason: "desktop unavailable",
          }
        : undefined,
    healthAll: async () => (
      calls.push("healthAll"),
      { stub: { status: "available", message: "stub ok" } }
    ),
    lastHealth: () => ({ stub: health }),
    modelsAll: async () => (calls.push("modelsAll"), { stub: ["stub-1", "stub-2"] }),
    cachedModels: () => ({ stub: ["stub-1"] }),
    cachedLiveModels: () => ({ stub: [] }),
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-catalog-"));
  await new SettingsStore(root).save(defaultSettings());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("the injected tool catalog", () => {
  it("is what the REST routes list, check and read models from", async () => {
    const calls: string[] = [];
    const app = createApp({
      service: new TaskService(root, stubCatalog(calls)),
      peerAddress: () => "127.0.0.1",
    });
    const get = async (path: string, method = "GET") =>
      (await app.request(`http://localhost/api/v1${path}`, { method })).json();

    const details = await get("/models/details");
    expect(Object.keys(details.tools)).toEqual(["stub"]);
    expect(details.tools.stub.displayName).toBe("Stub tool");
    expect(details.tools.stub.unavailableReason).toBe("desktop unavailable");
    expect(details.tools.stub.health).toMatchObject({ message: "stub ok" });

    expect((await get("/health/check", "POST")).tools).toMatchObject({
      stub: { message: "stub ok", unavailableReason: "desktop unavailable" },
    });
    expect((await get("/health")).tools.stub.unavailableReason).toBe("desktop unavailable");
    expect((await get("/models/refresh", "POST")).models.stub).toEqual(
      expect.arrayContaining(["stub-1", "stub-2"]),
    );
    expect(calls).toEqual(["healthAll", "modelsAll"]);
  });

  it("is what MCP over HTTP serves too (boof_get_model_details, boof_refresh_models)", async () => {
    const calls: string[] = [];
    const app = createApp({
      service: new TaskService(root, stubCatalog(calls)),
      peerAddress: () => "127.0.0.1",
    });
    const tool = async (name: string) => {
      const res = await app.request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });
      return (await res.json()).result;
    };
    const details = await tool("boof_get_model_details");
    expect(Object.keys(details.structuredContent.tools)).toEqual(["stub"]);
    expect(details.structuredContent.tools.stub.displayName).toBe("Stub tool");
    const refreshed = await tool("boof_refresh_models");
    expect(refreshed.structuredContent.models.stub).toEqual(
      expect.arrayContaining(["stub-1", "stub-2"]),
    );
    expect(calls).toEqual(["modelsAll"]);
  });
});
