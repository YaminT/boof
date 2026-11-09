import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, BROWSER_SESSION_MAX_MS, browserSessionCookieName } from "@boof/heart";
import {
  createQuitHandler,
  desktopSessionCookie,
  isAppUrl,
  isExternalUrl,
  operatorClientId,
  shutdownGraceMs,
} from "./lifecycle.js";

describe("desktop lifecycle", () => {
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
    it("uses the shared bin boot composition to build the server registry", async () => {
      const { readFile } = await import("node:fs/promises");
      const src = await readFile(new URL("./main.ts", import.meta.url), "utf8");
      const boot = await readFile(new URL("../../../bin/src/boot.ts", import.meta.url), "utf8");
      expect(src).toContain('import { boot } from "@boof/boof/boot"');
      expect(boot).toContain("const registry = new ToolRegistry(");
      expect(boot).toContain("defaultTools(");
      expect(boot).toContain("claudeAgentUnavailable: DESKTOP_CLAUDE_AGENT_REASON");
    });
  });
});

describe("desktop session cookie", () => {
  it("desktopSessionCookie targets the app origin with boof_ui_<port>, HttpOnly, SameSite strict, 30-day expiry", () => {
    const nowMs = 1_700_000_000_000;
    const cookie = desktopSessionCookie("http://127.0.0.1:4319", 4319, "bs_abc", nowMs);
    expect(cookie).toEqual({
      url: "http://127.0.0.1:4319",
      name: browserSessionCookieName(4319),
      value: "bs_abc",
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      expirationDate: (nowMs + BROWSER_SESSION_MAX_MS) / 1000,
    });
    expect(cookie.name).toBe("boof_ui_4319");
  });
});
