import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, BrowserSessionStore, browserSessionCookieName } from "@boof/heart";
import { startServer } from "@boof/heart-server";
import { MockTool, ToolRegistry } from "@boof/runner";
import {
  createQuitHandler,
  createWindowAuth,
  desktopKeyringAvailable,
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

describe("desktop keyring", () => {
  it("uses safeStorage on macOS and Windows when encryption is available", () => {
    expect(desktopKeyringAvailable({ platform: "darwin", encryptionAvailable: true })).toBe(true);
    expect(
      desktopKeyringAvailable({
        platform: "win32",
        encryptionAvailable: true,
        backend: "basic_text",
      }),
    ).toBe(true);
  });

  it("uses the fallback when encryption is unavailable", () => {
    expect(
      desktopKeyringAvailable({
        platform: "linux",
        encryptionAvailable: false,
        backend: "gnome_libsecret",
      }),
    ).toBe(false);
    expect(desktopKeyringAvailable({ platform: "darwin", encryptionAvailable: false })).toBe(false);
  });

  it("on Linux, only a real keyring counts; basic_text is the fallback", () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      expect(
        desktopKeyringAvailable({ platform: "linux", encryptionAvailable: true, backend }),
      ).toBe(true);
    }
    for (const backend of ["basic_text", "unknown", "", null, undefined]) {
      expect(
        desktopKeyringAvailable({ platform: "linux", encryptionAvailable: true, backend }),
      ).toBe(false);
    }
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
  it("desktopSessionCookie targets the app origin with boof_ui_<port>, HttpOnly, SameSite strict, and is a session cookie", () => {
    const cookie = desktopSessionCookie("http://127.0.0.1:4319", 4319, "bs_abc");
    expect(cookie).toEqual({
      url: "http://127.0.0.1:4319",
      name: browserSessionCookieName(4319),
      value: "bs_abc",
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    expect(cookie).not.toHaveProperty("expirationDate");
    expect(cookie.name).toBe("boof_ui_4319");
  });

  it("the server accepts the desktop cookie on its bound port and refuses other ports and cross-site", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-desktop-contract-"));
    const running = await startServer({
      catalog: new ToolRegistry([new MockTool()]),
      root,
      port: 0,
      warn: () => {},
    });
    try {
      const { token } = await new BrowserSessionStore(root).createSession();
      const origin = `http://127.0.0.1:${running.port}`;
      const c = desktopSessionCookie(origin, running.port, token);
      const get = (cookie?: string, headers: Record<string, string> = {}) =>
        fetch(`${origin}/api/settings`, {
          headers: { ...(cookie ? { cookie } : {}), ...headers },
        });
      expect((await get()).status).toBe(401);
      expect((await get(`${c.name}=${c.value}`)).status).toBe(200);
      expect((await get(`${browserSessionCookieName(running.port + 1)}=${c.value}`)).status).toBe(
        401,
      );
      expect((await get(`${c.name}=${c.value}`, { "Sec-Fetch-Site": "cross-site" })).status).toBe(
        403,
      );
    } finally {
      await running.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createWindowAuth", () => {
  const setup = (over: Partial<Parameters<typeof createWindowAuth>[0]> = {}) => {
    const order: string[] = [];
    let n = 0;
    const logs: string[] = [];
    const showFailure = vi.fn(async (m: string): Promise<void> => {
      order.push("dialog");
      logs.push(m);
    });
    const deps = {
      desktopToken: () => undefined as string | undefined,
      loadAuthMode: async () => "local-trust",
      createSession: vi.fn(async () => {
        const id = `s${++n}`;
        order.push(`create ${id}`);
        return { token: `bs_secret${n}`, session: { id } };
      }),
      revokeSession: vi.fn(async (id: string) => {
        order.push(`revoke ${id}`);
      }),
      setCookie: vi.fn(async (c: { value: string }) => {
        order.push(`cookie ${c.value}`);
      }),
      warn: (l: string) => logs.push(l),
      error: (l: string, e?: unknown) => logs.push(`${l} ${String(e ?? "")}`),
      showFailure,
      origin: "http://127.0.0.1:4319",
      port: 4319,
      ...over,
    };
    return { auth: createWindowAuth(deps), deps, showFailure, order, logs };
  };

  it("with a desktop key: no session, no cookie", async () => {
    const { auth, deps } = setup({ desktopToken: () => "boof_key" });
    await auth.prepare();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.setCookie).not.toHaveBeenCalled();
  });

  it("local-trust without a key: mints a session and sets the cookie before resolving", async () => {
    const { auth, deps, order } = setup();
    await auth.prepare();
    expect(order).toEqual(["create s1", "cookie bs_secret1"]);
    expect(deps.setCookie).toHaveBeenCalledWith(
      desktopSessionCookie("http://127.0.0.1:4319", 4319, "bs_secret1"),
    );
  });

  it("renews the session on a timer while the window stays open, revoking the old one", async () => {
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const schedule = (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    };
    const { auth, deps, order } = setup({ schedule, renewMs: 1234 });
    await auth.prepare();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1234);
    timers[0]!.fn();
    await vi.waitFor(() => expect(deps.createSession).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    expect(order).toEqual([
      "create s1",
      "cookie bs_secret1",
      "create s2",
      "cookie bs_secret2",
      "revoke s1",
    ]);
    // Only the live timer is armed; release stops it and revokes the current session.
    await auth.release();
    expect(timers[1]!.cancelled).toBe(true);
    expect(order.at(-1)).toBe("revoke s2");
  });

  it("no timer with a desktop key, and none after release", async () => {
    const timers: unknown[] = [];
    const schedule = () => {
      timers.push(1);
      return () => {};
    };
    const keyed = setup({ desktopToken: () => "boof_key", schedule });
    await keyed.auth.prepare();
    expect(timers).toHaveLength(0);
    const plain = setup({ schedule });
    await plain.auth.release();
    await plain.auth.prepare();
    expect(timers).toHaveLength(0);
  });

  it("required: no session and the exact warning", async () => {
    const { auth, deps, logs } = setup({ loadAuthMode: async () => "required" });
    await auth.prepare();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.setCookie).not.toHaveBeenCalled();
    expect(logs).toEqual([
      'desktop UI: safeStorage unavailable and auth.mode is "required"; paste an API key in the window',
    ]);
  });

  it("a failing createSession resolves, sets no cookie, shows the store's fix and never logs a token", async () => {
    const { auth, deps, showFailure, logs } = setup({
      createSession: vi.fn(async () => {
        throw new Error("auth dir is group-writable; run: chmod go-w /x/auth");
      }),
    });
    await expect(auth.prepare()).resolves.toBeUndefined();
    expect(deps.setCookie).not.toHaveBeenCalled();
    expect(showFailure).toHaveBeenCalledOnce();
    expect(showFailure.mock.calls[0]![0]).toContain("chmod go-w /x/auth");
    expect(logs.join("\n")).not.toMatch(/bs_/);
  });

  it("every prepare (activate) signs in again and revokes the previous session", async () => {
    const { auth, order } = setup();
    await auth.prepare();
    await auth.prepare();
    expect(order).toEqual([
      "create s1",
      "cookie bs_secret1",
      "create s2",
      "cookie bs_secret2",
      "revoke s1",
    ]);
  });

  it("concurrent prepares are serialised", async () => {
    const { auth, order } = setup();
    await Promise.all([auth.prepare(), auth.prepare()]);
    expect(order).toEqual([
      "create s1",
      "cookie bs_secret1",
      "create s2",
      "cookie bs_secret2",
      "revoke s1",
    ]);
  });

  it("release revokes the current session once", async () => {
    const { auth, order } = setup();
    await auth.prepare();
    await auth.release();
    await auth.release();
    expect(order.filter((o) => o.startsWith("revoke"))).toEqual(["revoke s1"]);
  });

  it("a revoke failure is logged, not thrown", async () => {
    const { auth } = setup({
      revokeSession: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await auth.prepare();
    await expect(auth.prepare()).resolves.toBeUndefined();
    await expect(auth.release()).resolves.toBeUndefined();
  });

  // Sixty create/revoke rounds rewrite the session file. The default 20s test
  // timeout already failed this on a loaded 4-core host (the file reached 21s).
  it("60 launches leave at most one desktop session and never evict a boof-runner open session", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-desktop-churn-"));
    try {
      const store = new BrowserSessionStore(root);
      const opened = await store.createSession(); // stands in for `boof-runner open`
      for (let launch = 0; launch < 60; launch++) {
        const auth = createWindowAuth({
          desktopToken: () => undefined,
          loadAuthMode: async () => "local-trust",
          createSession: () => store.createSession(),
          revokeSession: (id) => store.revokeSession(id),
          setCookie: async () => {},
          warn: () => {},
          error: () => {},
          showFailure: () => {},
          origin: "http://127.0.0.1:4319",
          port: 4319,
        });
        await auth.prepare();
        await auth.prepare(); // a window re-open in the same launch
        await auth.release(); // quit
      }
      expect((await store.verify(opened.token))?.id).toBe(opened.session.id);
      const rows = JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile(join(root, "auth", "browser-sessions.json"), "utf8"),
      );
      expect((Array.isArray(rows) ? rows : rows.sessions).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("quit runs cleanup after the drain and before the server stops", async () => {
    const order: string[] = [];
    const quit = createQuitHandler({
      engine: () => ({
        shutdown: async () => (order.push("drain"), { stopped: [], timedOut: false }),
      }),
      server: () => ({ stop: async () => void order.push("stop") }),
      exit: () => order.push("exit"),
      graceMs: 1,
      cleanup: async () => void order.push("cleanup"),
      log: () => {},
    });
    await quit({ preventDefault() {} });
    expect(order).toEqual(["drain", "cleanup", "stop", "exit"]);
  });
});
