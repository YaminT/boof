import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PRINCIPAL, AuthStore, settingsVersion } from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";
import { publicSettings } from "./admin.js";

let root: string;
let service: TaskService;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-settings-n8n-"));
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const ctx = (): OpContext => ({
  root,
  principal: LOCAL_PRINCIPAL,
  services: service,
  authStore: new AuthStore(root),
  now: () => "2026-01-01T00:00:00.000Z",
});
const run = (name: string, input: object = {}) =>
  getOp(name)!.execute(ctx(), input) as Promise<Record<string, any>>;

const N8N = { baseUrl: "http://n8n:5678", callbackBaseUrl: "https://b.x" };

describe("settings with an n8n block", () => {
  it("publicSettings drops webhooks and n8n", () => {
    const out = publicSettings({ a: 1, webhooks: [], n8n: N8N });
    expect(out).toEqual({ a: 1 });
  });

  it("settings.get and settings.update never include n8n", async () => {
    await service.settingsStore.mutate((s) => ({ ...s, n8n: N8N }) as typeof s);
    expect(await run("settings.get")).not.toHaveProperty("n8n");
    const updated = await run("settings.update", { runner: { enabled: false } });
    expect(updated).not.toHaveProperty("n8n");
  });

  it("the ETag from settings.get still matches a conditional update after settings.n8n is written", async () => {
    await service.settingsStore.mutate((s) => ({ ...s, n8n: N8N }) as typeof s);
    const got = await run("settings.get");
    const etag = settingsVersion(got);
    expect(etag).toBe(settingsVersion(await service.loadSettings()));
    await expect(
      run("settings.update", { runner: { enabled: false }, expectedUpdated: etag }),
    ).resolves.toBeDefined();
  });
});
