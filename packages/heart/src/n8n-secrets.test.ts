import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { N8nSecretStore } from "./n8n-secrets.js";
import { dataRootPaths } from "./paths.js";
import { writeFile, mkdir } from "node:fs/promises";

let root: string;
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "boof-n8nsec-"))));
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe("N8nSecretStore", () => {
  it("BOOF_N8N_API_KEY wins and is never written", async () => {
    const store = new N8nSecretStore(root, { BOOF_N8N_API_KEY: "  envkey  " });
    expect(await store.getApiKey()).toBe("envkey");
    expect(await store.apiKeySource()).toBe("env");
    await expect(stat(store.filePath)).rejects.toThrow();
    await store.setApiKey("filekey");
    expect(await store.getApiKey()).toBe("envkey");
    expect(await readFile(store.filePath, "utf8")).not.toContain("envkey");
  });

  it("a blank env value is ignored", async () => {
    const store = new N8nSecretStore(root, { BOOF_N8N_API_KEY: "   " });
    expect(await store.getApiKey()).toBeNull();
    expect(await store.apiKeySource()).toBeNull();
  });

  it("set, get, delete the API key; apiKeySource follows", async () => {
    const store = new N8nSecretStore(root, {});
    expect(await store.getApiKey()).toBeNull();
    await store.setApiKey("k-123");
    expect(await store.getApiKey()).toBe("k-123");
    expect(await store.apiKeySource()).toBe("file");
    await store.deleteApiKey();
    expect(await store.getApiKey()).toBeNull();
    expect(await store.apiKeySource()).toBeNull();
  });

  it("rotateWebhookSecret returns n8nwh_ + 48 hex, differs each time, and is stored", async () => {
    const store = new N8nSecretStore(root, {});
    const a = await store.rotateWebhookSecret();
    expect(a).toMatch(/^n8nwh_[0-9a-f]{48}$/);
    expect(await store.getWebhookSecret()).toBe(a);
    const b = await store.rotateWebhookSecret();
    expect(b).not.toBe(a);
    expect(await store.getWebhookSecret()).toBe(b);
  });

  it("the key and the secret do not clobber each other", async () => {
    const store = new N8nSecretStore(root, {});
    await store.setApiKey("k");
    const s = await store.rotateWebhookSecret();
    await store.deleteApiKey();
    expect(await store.getWebhookSecret()).toBe(s);
  });

  it("a corrupt file reports 'n8n/secrets.json is not valid JSON' without quoting it", async () => {
    const p = dataRootPaths(root).n8nSecrets;
    await mkdir(join(root, "n8n"), { recursive: true });
    await writeFile(p, "{ SECRETVALUE-oops");
    const store = new N8nSecretStore(root, {});
    const err = await store.getApiKey().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("n8n/secrets.json is not valid JSON");
    expect(err?.message).not.toContain("SECRETVALUE");
  });

  it("an invalid key is refused without echoing it", async () => {
    const store = new N8nSecretStore(root, {});
    for (const bad of ["", "has\nnewline-SECRET", "é-SECRET", "x".repeat(2049)]) {
      const err = await store.setApiKey(bad).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toBe("invalid n8n API key");
    }
  });

  it.skipIf(process.platform === "win32")("modes: folder 0700, file 0600", async () => {
    const store = new N8nSecretStore(root, {});
    await store.setApiKey("k");
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "n8n"))).mode & 0o777).toBe(0o700);
  });

  it("deleteAll removes the file", async () => {
    const store = new N8nSecretStore(root, {});
    await store.setApiKey("k");
    await store.deleteAll();
    await expect(stat(store.filePath)).rejects.toThrow();
    expect(await store.getApiKey()).toBeNull();
  });
});
