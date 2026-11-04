import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwlishSecretStore } from "./owlish-secrets.js";
import { dataRootPaths, defaultSettings, SettingsStore } from "@boof/heart";

let root: string;
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "boof-owsec-"))));
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const KEY = "btr-" + "a1".repeat(20);

describe("OwlishSecretStore", () => {
  it("has no key until one is set", async () => {
    const store = new OwlishSecretStore(root, {});
    expect(await store.get()).toBeNull();
    expect(await store.source()).toBeNull();
  });

  it("sets, reads and deletes the key at owlish/secrets.json, mode 0600 in a 0700 directory", async () => {
    const store = new OwlishSecretStore(root, {});
    await store.set(KEY);
    expect(store.filePath).toBe(join(root, "owlish", "secrets.json"));
    expect(dataRootPaths(root).owlishSecrets).toBe(store.filePath);
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "owlish"))).mode & 0o777).toBe(0o700);
    expect(await store.get()).toBe(KEY);
    expect(await store.source()).toBe("file");
    await store.delete();
    expect(await store.get()).toBeNull();
    await store.delete(); // deleting nothing is fine
  });

  it("BOOF_OWLISH_API_KEY wins over the file and is never written", async () => {
    await new OwlishSecretStore(root, {}).set(KEY);
    const env = new OwlishSecretStore(root, { BOOF_OWLISH_API_KEY: "btr-from-env-0001" });
    expect(await env.get()).toBe("btr-from-env-0001");
    expect(await env.source()).toBe("env");
    expect(await readFile(env.filePath, "utf8")).not.toContain("from-env");
    // An empty variable is not a key.
    const empty = new OwlishSecretStore(root, { BOOF_OWLISH_API_KEY: "  " });
    expect(await empty.get()).toBe(KEY);
  });

  it("refuses a key that is empty, has whitespace or control characters, or is absurdly long", async () => {
    const store = new OwlishSecretStore(root, {});
    for (const bad of ["", "   ", "a b", "btr-\nx", "btr-\u0000", "x".repeat(2000)]) {
      await expect(store.set(bad), JSON.stringify(bad.slice(0, 10))).rejects.toThrow(/key/);
    }
    expect(await store.get()).toBeNull();
  });

  it("the key is not in settings.json and settings reads carry no secret", async () => {
    await new OwlishSecretStore(root, {}).set(KEY);
    const settings = new SettingsStore(root);
    await settings.save({
      ...defaultSettings(),
      owlish: { url: "http://127.0.0.1:8080", healthGate: "pause" },
    });
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain(KEY);
    expect(JSON.stringify(await settings.load())).not.toContain(KEY);
  });

  it("a damaged file reads as an error that never quotes its contents", async () => {
    const store = new OwlishSecretStore(root, {});
    await mkdir(join(root, "owlish"), { recursive: true });
    await writeFile(store.filePath, `btr-LEAKED-${KEY} not json`);
    const err = await store.get().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain("LEAKED");
    expect(String(err.message)).not.toContain(KEY);
    await writeFile(store.filePath, JSON.stringify(["btr-LEAKED"]));
    expect(String((await store.get().catch((e) => e)).message)).not.toContain("LEAKED");
    await writeFile(store.filePath, JSON.stringify({ apiKey: 5 }));
    expect(await store.get()).toBeNull();
  });

  it("serializes concurrent sets (last write wins, file stays valid)", async () => {
    const store = new OwlishSecretStore(root, {});
    await Promise.all([1, 2, 3].map((n) => store.set(`btr-key-number-${n}`)));
    expect(["btr-key-number-1", "btr-key-number-2", "btr-key-number-3"]).toContain(
      await store.get(),
    );
  });

  it("tighten brings a loose file to 0600", async () => {
    const store = new OwlishSecretStore(root, {});
    await store.set(KEY);
    const { chmod } = await import("node:fs/promises");
    await chmod(store.filePath, 0o644);
    await store.tighten();
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
  });
});
