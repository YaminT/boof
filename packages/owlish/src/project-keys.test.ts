import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectKeyStore, redactSecrets } from "./project-keys.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});
const setup = async () => {
  root = await mkdtemp(join(tmpdir(), "owlish-keys-"));
  return new ProjectKeyStore(root);
};
const KEY = "sk-ant-api03-abcdefghijklmnop";

describe("ProjectKeyStore", () => {
  it("sets, gets, checks and deletes independent project keys", async () => {
    const store = await setup();
    expect(await store.get("one")).toBeNull();
    await store.set("one", KEY);
    await store.set("two", "sk-ant-api03-qrstuvwxyzABCDEF");
    expect(await store.has("one")).toBe(true);
    expect(await store.get("one")).toBe(KEY);
    await store.delete("one");
    expect(await store.has("one")).toBe(false);
    expect(await store.has("two")).toBe(true);
    if (process.platform !== "win32")
      expect(
        (await stat((await import("@boof/heart")).dataRootPaths(root).owlishProjectKeys)).mode &
          0o777,
      ).toBe(0o600);
  });
  it("rejects OAuth tokens without echoing them and hides corrupt file contents", async () => {
    const store = await setup();
    const oauth = "sk-ant-oat01-supersecretvalue";
    await expect(store.set("p", oauth)).rejects.not.toThrow(oauth);
    const path = (await import("@boof/heart")).dataRootPaths(root).owlishProjectKeys;
    await (await import("node:fs/promises")).mkdir(join(root, "owlish"), { recursive: true });
    await (await import("node:fs/promises")).writeFile(path, "private-corrupt-content");
    await expect(store.get("p")).rejects.not.toThrow("private-corrupt-content");
  });
});

it("redactSecrets replaces every occurrence of secrets of at least eight characters", () => {
  expect(redactSecrets("key=abcdefgh and abcdefgh", ["abcdefgh", "short"])).toBe(
    "key=[redacted] and [redacted]",
  );
});
