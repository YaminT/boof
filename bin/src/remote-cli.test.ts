import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, SettingsStore } from "@boof-runner/shared";
import { assertBindAllowed } from "@boof-runner/web";
import { normaliseHostname, remoteCommand } from "./remote-cli.js";

let root: string;
let out: string[];
let errs: string[];

const run = (...argv: string[]) =>
  remoteCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
  );
const settingsPath = () => join(root, "settings.json");
const rawSettings = async () => JSON.parse(await readFile(settingsPath(), "utf8"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-remote-"));
  await chmod(root, 0o755);
  out = [];
  errs = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("normaliseHostname", () => {
  it("strips scheme, port and path and lowercases", () => {
    expect(normaliseHostname("https://Boof.Example.com:8443/x")).toBe("boof.example.com");
    expect(normaliseHostname("boof.example.com")).toBe("boof.example.com");
    expect(normaliseHostname("")).toBeNull();
    expect(normaliseHostname("a b")).toBeNull();
  });
});

describe("boof-runner remote setup", () => {
  it("writes settings, keeps other keys, creates a key, fixes permissions and prints next steps", async () => {
    await new SettingsStore(root).load();
    const before = await rawSettings();
    before.futureKey = { keep: "me" };
    before.security = { rateLimit: { perMinute: 7 }, allowedHosts: ["old.example.com"] };
    await writeFile(settingsPath(), JSON.stringify(before));

    expect(
      await run(
        "setup",
        "--hostname",
        "https://Boof.Example.com:443/",
        "--allowed-root",
        "/tmp/x",
        "--allowed-root",
        "~/codes",
        "-p",
        "4400",
      ),
    ).toBe(0);
    const s = await rawSettings();
    expect(s.futureKey).toEqual({ keep: "me" });
    expect(s.security.auth.mode).toBe("required");
    expect(s.security.rateLimit.perMinute).toBe(7);
    expect(s.security.allowedHosts).toEqual(["old.example.com", "boof.example.com"]);
    expect(s.security.allowedProjectRoots).toContain("~/codes");
    expect(s.security.allowedProjectRoots).toContain("/tmp/x");

    const text = out.join("\n");
    const key = out.map((l) => l.trim()).find((l) => l.startsWith("boof_harness_"))!;
    expect(key).toBeTruthy();
    expect((await new AuthStore(root).verify(key)).ok).toBe(true);
    expect((await stat(root)).mode & 0o077).toBe(0);
    expect(text).toContain("chmod 700");
    expect(text).toContain("--host 0.0.0.0 -p 4400 --tls-cert");
    expect(text).toContain("reverse_proxy 127.0.0.1:4400");
    expect(text).toContain("cloudflared tunnel run --url http://127.0.0.1:4400");
    expect(text).toContain("cloudflared tunnel route dns <tunnel-name> boof.example.com");
    expect(text).toContain("--no-key --hostname <random-name>.trycloudflare.com");
    expect(text).toContain("BOOF_URL=https://boof.example.com");
    expect(text).toContain("https://nodets.com/boof/harness.txt");
  });

  it("is idempotent with --no-key and creates no client", async () => {
    const args = [
      "setup",
      "--hostname",
      "boof.example.com",
      "--allowed-root",
      "/tmp/x",
      "--no-key",
    ];
    expect(await run(...args)).toBe(0);
    const first = await readFile(settingsPath(), "utf8");
    expect(await run(...args)).toBe(0);
    expect(await readFile(settingsPath(), "utf8")).toBe(first);
    expect(await new AuthStore(root).list()).toHaveLength(0);
    expect(JSON.parse(first).security.allowedHosts).toEqual(["boof.example.com"]);
  });

  it("a second run with the same client name fails and leaves settings unchanged", async () => {
    expect(await run("setup", "--hostname", "boof.example.com")).toBe(0);
    const first = await readFile(settingsPath(), "utf8");
    out.length = 0;
    expect(await run("setup", "--hostname", "other.example.com", "--allowed-root", "/tmp/y")).toBe(
      1,
    );
    expect(await readFile(settingsPath(), "utf8")).toBe(first);
    expect(errs.join("\n")).toContain("auth rotate harness");
    expect(await new AuthStore(root).list()).toHaveLength(1);
    // A free name works.
    expect(await run("setup", "--hostname", "boof.example.com", "--name", "ci")).toBe(0);
    expect(await new AuthStore(root).list()).toHaveLength(2);
  });

  it("requires a valid hostname and rejects unknown scopes", async () => {
    expect(await run("setup")).toBe(1);
    expect(await run("setup", "--hostname", "bad host")).toBe(1);
    expect(await run("setup", "--hostname", "a.example.com", "--scopes", "nope")).toBe(1);
  });
});

describe("boof-runner remote status / disable", () => {
  it("status reports the configuration and the bind verdict; disable turns it back", async () => {
    expect(await run("setup", "--hostname", "boof.example.com", "--allowed-root", "/tmp/x")).toBe(
      0,
    );
    out.length = 0;
    expect(await run("status")).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Auth mode:             required");
    expect(text).toContain("boof.example.com");
    expect(text).toContain("/tmp/x");
    expect(text).toContain("Active clients:        1");
    expect(text).toContain("Data root permissions: 700");
    expect(text).toContain("Non-loopback bind:     allowed");

    const store = new AuthStore(root);
    await expect(
      assertBindAllowed("0.0.0.0", await new SettingsStore(root).load(), store),
    ).resolves.toBeUndefined();

    out.length = 0;
    expect(await run("disable")).toBe(0);
    expect(out.join("\n")).toContain("local-trust");
    const s = await rawSettings();
    expect(s.security.auth.mode).toBe("local-trust");
    expect(s.security.allowedHosts).toEqual(["boof.example.com"]);
    expect(await store.list()).toHaveLength(1);
    await expect(
      assertBindAllowed("0.0.0.0", await new SettingsStore(root).load(), store),
    ).rejects.toThrow(/refusing to bind/);

    out.length = 0;
    expect(await run("status")).toBe(0);
    expect(out.join("\n")).toContain("Non-loopback bind:     refused");
  });

  it("status without settings fails cleanly", async () => {
    expect(await run("status")).toBe(1);
  });
});
