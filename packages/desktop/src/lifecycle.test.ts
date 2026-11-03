import { describe, expect, it, vi } from "vitest";
import { MockTool, ToolRegistry, type RunnerEngine } from "@boof-runner/runner";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "@boof-runner/shared";
import {
  createQuitHandler,
  isAppUrl,
  isExternalUrl,
  operatorClientId,
  serverOptions,
  shutdownGraceMs,
} from "./lifecycle.js";

describe("desktop /healthz facts", () => {
  it("passes the app version and a live runnerRunning to the server", () => {
    let engine: RunnerEngine | null = null;
    const catalog = new ToolRegistry([new MockTool()]);
    const opts = serverOptions(
      { root: "/r", port: 4319, uiDir: "/ui", catalog },
      "0.2.0",
      () => engine,
    );
    expect(opts).toMatchObject({ root: "/r", port: 4319, uiDir: "/ui", version: "0.2.0" });
    expect(opts.catalog).toBe(catalog); // the registry the app built reaches startServer unchanged
    expect(opts.runnerRunning?.()).toBe(false);
    engine = {} as RunnerEngine; // engine.loop() started
    expect(opts.runnerRunning?.()).toBe(true);
  });

  it("marks the desktop client as the operator only when an id is given", () => {
    const base = { root: "/r", port: 1, catalog: new ToolRegistry([new MockTool()]) };
    expect(serverOptions(base, "1.0.0", () => null, "desktop-ui").operatorClients).toEqual(
      new Set(["desktop-ui"]),
    );
    expect(serverOptions(base, "1.0.0", () => null).operatorClients).toBeUndefined();
  });

  it("reads the grace period from BOOF_RUNNER_SHUTDOWN_GRACE_MS, default 30 s", () => {
    expect(shutdownGraceMs({})).toBe(30_000);
    expect(shutdownGraceMs({ BOOF_RUNNER_SHUTDOWN_GRACE_MS: "5000" })).toBe(5_000);
    expect(shutdownGraceMs({ BOOF_RUNNER_SHUTDOWN_GRACE_MS: "soon" })).toBe(30_000);
  });
});

describe("desktop before-quit", () => {
  const setup = () => {
    const order: string[] = [];
    let release!: () => void;
    const drained = new Promise<void>((r) => (release = r));
    const engine = {
      shutdown: vi.fn(async (graceMs: number) => {
        order.push(`shutdown ${graceMs}`);
        await drained;
        return { stopped: ["t1"], timedOut: false };
      }),
    };
    const server = { stop: vi.fn(async () => void order.push("server.stop")) };
    const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
    const log: string[] = [];
    const quit = createQuitHandler({
      engine: () => engine,
      server: () => server,
      exit,
      graceMs: 5_000,
      log: (l) => log.push(l),
    });
    return { order, release, engine, server, exit, log, quit };
  };

  it("defers the quit, drains the engine, stops the server, then exits 0", async () => {
    const s = setup();
    const event = { preventDefault: vi.fn() };
    const pending = s.quit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(s.order).toEqual(["shutdown 5000"]); // nothing else until the engine drained
    s.release();
    await pending;
    expect(s.order).toEqual(["shutdown 5000", "server.stop", "exit 0"]);
    expect(s.log).toContain("Stopped running task(s): t1");
  });

  it("tells the user while it drains that a second quit forces it", async () => {
    const notices: string[] = [];
    const s = setup();
    const quit = createQuitHandler({
      engine: () => s.engine,
      server: () => s.server,
      exit: s.exit,
      graceMs: 5_000,
      log: () => {},
      notify: (m) => notices.push(m),
    });
    const first = quit({ preventDefault: vi.fn() });
    expect(notices).toEqual(["Stopping running task... (quit again to force)"]);
    quit({ preventDefault: vi.fn() }); // the forcing quit does not notify again
    expect(notices).toHaveLength(1);
    s.release();
    await first;
  });

  it("a second quit request while draining is not deferred", async () => {
    const s = setup();
    const first = s.quit({ preventDefault: vi.fn() });
    const again = { preventDefault: vi.fn() };
    expect(s.quit(again)).toBeUndefined();
    expect(again.preventDefault).not.toHaveBeenCalled();
    expect(s.engine.shutdown).toHaveBeenCalledTimes(1);
    s.release();
    await first;
  });

  it("exits 0 even when the engine shutdown rejects, and logs it", async () => {
    const s = setup();
    s.engine.shutdown.mockRejectedValueOnce(new Error("disk gone"));
    await s.quit({ preventDefault: vi.fn() });
    expect(s.order).toEqual(["exit 0"]);
    expect(s.log.some((l) => l.includes("disk gone"))).toBe(true);
  });

  it("says when the grace period ran out", async () => {
    const s = setup();
    s.engine.shutdown.mockImplementationOnce(async (graceMs: number) => {
      s.order.push(`shutdown ${graceMs}`);
      return { stopped: ["t1"], timedOut: true };
    });
    await s.quit({ preventDefault: vi.fn() });
    expect(s.log).toContain("Grace period of 5000 ms elapsed; quitting anyway");
    expect(s.order).toEqual(["shutdown 5000", "server.stop", "exit 0"]);
  });
});

describe("operatorClientId", () => {
  it("is the client id inside the key the desktop holds, and undefined without a usable key", () => {
    expect(operatorClientId("boof_desktop-ui_c2VjcmV0")).toBe("desktop-ui");
    expect(operatorClientId(undefined)).toBeUndefined();
    expect(operatorClientId("not a key")).toBeUndefined();
  });

  it("follows the re-issued client after desktop-ui was revoked", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-desktop-op-"));
    try {
      const store = new AuthStore(root);
      await store.create({ name: "desktop-ui", kind: "ui", scopes: ["admin"], trust: "trusted" });
      await store.revoke("desktop-ui");
      const second = await store.create({
        name: "desktop-ui",
        kind: "ui",
        scopes: ["admin"],
        trust: "trusted",
      });
      expect(second.client.id).toMatch(/^desktop-ui-[0-9a-f]{4}$/);
      expect(operatorClientId(second.key)).toBe(second.client.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isAppUrl", () => {
  const origin = "http://127.0.0.1:4319";
  it("accepts pages of the app's own origin", () => {
    for (const u of [origin, `${origin}/`, `${origin}/p/a/tasks?x=1#h`])
      expect(isAppUrl(u, origin)).toBe(true);
  });
  it("refuses every other origin and odd scheme", () => {
    for (const u of [
      "http://127.0.0.1:4319@evil.com/",
      "http://127.0.0.1:4319.evil.com/",
      "http://user@127.0.0.1:4319/",
      "http://127.0.0.1:4320/",
      "http://localhost:4319/",
      "https://127.0.0.1:4319/",
      "http://[::1]:4319/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "about:blank",
      "",
      "not a url",
    ])
      expect(isAppUrl(u, origin), u).toBe(false);
  });
});

describe("isExternalUrl", () => {
  it("allows only http and https for the system browser", () => {
    expect(isExternalUrl("https://example.com/docs")).toBe(true);
    expect(isExternalUrl("http://example.com")).toBe(true);
    for (const u of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "smb://h/s",
      "ssh://h",
      "",
      "nope",
    ])
      expect(isExternalUrl(u), u).toBe(false);
  });

  describe("desktop main", () => {
    it("builds a real ToolRegistry for the server it starts (Heart builds none)", async () => {
      const { readFile } = await import("node:fs/promises");
      const src = await readFile(new URL("./main.ts", import.meta.url), "utf8");
      expect(src).toMatch(/serverOptions\(\s*\{[^}]*catalog: new ToolRegistry\(\)/);
    });
  });
});
