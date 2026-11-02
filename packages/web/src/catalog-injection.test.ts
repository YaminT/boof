import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  SettingsStore,
  type CachedHealth,
  type ToolCatalog,
} from "@boof-runner/shared";
import { TaskService } from "@boof-runner/api";
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
    list: () => [{ id: "stub", displayName: "Stub tool", defaultModels: ["stub-1"] }],
    get: (id) =>
      id === "stub" ? { id, displayName: "Stub tool", defaultModels: ["stub-1"] } : undefined,
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
    expect(details.tools.stub.health).toMatchObject({ message: "stub ok" });

    expect((await get("/health/check", "POST")).tools).toMatchObject({
      stub: { message: "stub ok" },
    });
    expect((await get("/models/refresh", "POST")).models.stub).toEqual(
      expect.arrayContaining(["stub-1", "stub-2"]),
    );
    expect(calls).toEqual(["healthAll", "modelsAll"]);
  });
});
