import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { TaskService } from "./services/service.js";

let root: string;
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "boof-owkey-"))));
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe("TaskService and the Owlish client key", () => {
  const catalog = { list: () => [] } as never;

  it("holds the key store, and loadSettings never returns the key", async () => {
    await new SettingsStore(root).save({
      ...defaultSettings(),
      owlish: { url: "http://127.0.0.1:8080", healthGate: "pause" },
    });
    const svc = new TaskService(root, catalog);
    await svc.owlishSecrets.set("btr-service-key-0001");
    expect(await svc.owlishSecrets.get()).toBe("btr-service-key-0001");
    expect(JSON.stringify(await svc.loadSettings())).not.toContain("btr-service-key");
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("btr-service-key");
  });
});
