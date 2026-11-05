import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("does not treat object prototype names as stored keys", async () => {
    const store = await setup();
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(await store.has(id)).toBe(false);
      expect(await store.get(id)).toBeNull();
    }
  });
  it("delete removes a same-id invalid entry instead of preserving it", async () => {
    const store = await setup();
    const path = (await import("@boof/heart")).dataRootPaths(root).owlishProjectKeys;
    await mkdir(join(root, "owlish"), { recursive: true });
    await writeFile(path, '{"keys":{"project":"not-an-api-key"}}');
    await store.delete("project");
    await expect(store.get("project")).resolves.toBeNull();
    await expect((await import("node:fs/promises")).readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("tightens a fresh root without requiring a key file", async () => {
    const store = await setup();
    await expect(store.tighten()).resolves.toBeUndefined();
  });
  it("preserves invalid entries on rewrite and warns once per file content", async () => {
    const store = await setup();
    const path = (await import("@boof/heart")).dataRootPaths(root).owlishProjectKeys;
    await mkdir(join(root, "owlish"), { recursive: true });
    await writeFile(path, JSON.stringify({ keys: { valid: KEY, bad: "not-a-key" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await store.get("valid")).toBe(KEY);
    expect(await store.get("bad")).toBeNull();
    expect(await store.get("bad")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "owlish/project-keys.json contains invalid entries; preserving them on write",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    await store.set("new", "sk-ant-api03-qrstuvwxyzABCDEF");
    const saved = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    expect(saved.keys).toMatchObject({
      valid: KEY,
      bad: "not-a-key",
      new: "sk-ant-api03-qrstuvwxyzABCDEF",
    });
    expect(await store.has("bad")).toBe(false);
    warn.mockRestore();
  });
  it("serializes concurrent independent writers with the process lock", async () => {
    const first = await setup();
    const second = new ProjectKeyStore(root);
    await first.set("revoked", KEY);
    await Promise.all([
      first.delete("revoked"),
      second.set("other", "sk-ant-api03-qrstuvwxyzABCDEF"),
    ]);
    expect(await first.get("revoked")).toBeNull();
    expect(await first.has("other")).toBe(true);
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

it.each([
  ["JSON", `{"key":"${KEY}"}`, `{"key":"[redacted]"}`],
  ["URL", `?key=${encodeURIComponent(KEY)}`, "?key=[redacted]"],
  ["percent-encoded", encodeURIComponent(KEY), "[redacted]"],
  [
    "JSON escaped",
    `token=${JSON.stringify('sk-ant-api03-ab"cd\\ef/gh+ij&kl%mn=op').slice(1, -1)}`,
    "token=[redacted]",
  ],
  ["truncated at start", `${KEY.slice(0, 23)} …`, "[redacted] …"],
  ["truncated at end of output", `prefix ${KEY.slice(0, 23)}`, "prefix [redacted]"],
  ["generic unknown key", "x sk-ant-api03-abcdefgh y", "x [redacted] y"],
  [
    "JSON keeps surrounding fields",
    `{"key":"sk-ant-api03-abcdefgh","model":"x"}`,
    `{"key":"[redacted]","model":"x"}`,
  ],
  ["OAuth token", "Bearer sk-ant-oat01-abcdefgh failed", "Bearer [redacted] failed"],
  ["admin token", "sk-ant-admin01-abcdefgh", "[redacted]"],
  ["normal text", "ordinary message and punctuation", "ordinary message and punctuation"],
])("redacts %s", (_label, input, expected) => {
  const escapedKey = 'sk-ant-api03-ab"cd\\ef/gh+ij&kl%mn=op';
  expect(redactSecrets(input, [KEY, escapedKey])).toBe(expected);
});

it("redacts the longest overlapping secret first", () => {
  expect(
    redactSecrets("sk-ant-api03-abcdefghijklmnop", [
      "sk-ant-api03-abcdefgh",
      "sk-ant-api03-abcdefghijklmnop",
    ]),
  ).toBe("[redacted]");
});
