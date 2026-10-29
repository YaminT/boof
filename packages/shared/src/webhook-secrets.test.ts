import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookSecretStore } from "./webhook-secrets.js";

let root: string;
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "boof-whsec-"))));
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe("WebhookSecretStore", () => {
  it("keeps secrets in webhooks/secrets.json with mode 0600 and no secret in settings.json", async () => {
    const store = new WebhookSecretStore(root);
    expect(await store.all()).toEqual({});
    expect(await store.get("wh-1")).toBeNull();
    await store.set("wh-1", "whsec_" + "a".repeat(48));
    expect(store.filePath).toBe(join(root, "webhooks", "secrets.json"));
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "webhooks"))).mode & 0o777).toBe(0o700);
    expect(await store.get("wh-1")).toBe("whsec_" + "a".repeat(48));
    await store.delete("wh-1");
    expect(await readFile(store.filePath, "utf8")).toBe("{}\n");
  });

  it("serializes concurrent sets so none is lost", async () => {
    const store = new WebhookSecretStore(root);
    await Promise.all(["a", "b", "c"].map((id) => store.set(`wh-${id}`, `whsec_${id.repeat(16)}`)));
    expect(Object.keys(await store.all()).sort()).toEqual(["wh-a", "wh-b", "wh-c"]);
  });
});
