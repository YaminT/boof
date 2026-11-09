import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  BrowserSessionStore,
  dataRootPaths,
  defaultSettings,
  SettingsStore,
  type SecuritySettings,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { TaskService } from "../api/index.js";
import { createApp } from "./app.js";
import { DataWatcher } from "./watch.js";

let base: string;
let root: string;
let service: TaskService;
let authStore: AuthStore;
let sessions: BrowserSessionStore;
let peer: string | undefined;
let watcher: DataWatcher | undefined;

const request = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) =>
  app.request(`http://localhost${path}`, init);

function build(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    service,
    authStore,
    browserSessions: sessions,
    sessionCookieName: () => "boof_ui_4319",
    peerAddress: () => peer,
    ...(watcher ? { watcher } : {}),
    ...extra,
  });
}

async function setMode(next: "local-trust" | "required", unauthenticatedPerMinute = 30) {
  const settings = defaultSettings();
  settings.security = {
    allowedHosts: [],
    auth: { mode: next },
    allowedProjectRoots: [],
    externalTasksRequireApproval: true,
    rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute },
    trustedProxies: ["loopback"],
    audit: { enabled: true, retentionDays: 90 },
  } satisfies SecuritySettings;
  await new SettingsStore(root).save(settings);
}

async function signIn(app = build()) {
  const { code } = await sessions.createLink();
  const response = await request(app, `/auth/browser?code=${encodeURIComponent(code)}`);
  return { code, response };
}

async function auditLines(): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  for (const file of await readdir(dataRootPaths(root).audit).catch(() => [])) {
    for (const line of (await readFile(join(dataRootPaths(root).audit, file), "utf8")).split(
      "\n",
    )) {
      if (line) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "boof-browser-session-"));
  root = join(base, "data");
  await setMode("local-trust");
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  authStore = new AuthStore(root);
  sessions = new BrowserSessionStore(root);
  peer = "127.0.0.1";
});

afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("browser session authentication", () => {
  it("keyless loopback /api without a session is 401 browser_session_required", async () => {
    const res = await request(build(), "/api/v1/whoami");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: {
        code: "unauthenticated",
        message: expect.stringContaining("boof-runner open"),
        details: { reason: "browser_session_required" },
      },
    });
  });

  it("a redeemed link signs in: 303 to /, cookie HttpOnly + SameSite=Strict, then whoami is local", async () => {
    const app = build();
    const { response } = await signIn(app);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^boof_ui_4319=bs_[^;]+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=2592000");
    const token = cookie.match(/^boof_ui_4319=([^;]+)/)![1];
    const who = await request(app, "/api/v1/whoami", {
      headers: { cookie: `boof_ui_4319=${token}` },
    });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ principal: { id: "local", kind: "local" } });
  });

  it("keyless /mcp under local-trust is 401 mcp_key_required", async () => {
    const res = await request(build(), "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: {
        details: { reason: "mcp_key_required" },
        message: expect.stringContaining("API key"),
      },
    });
  });

  it("a valid session cookie is ignored on /mcp", async () => {
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    const res = await request(app, "/mcp", {
      method: "POST",
      headers: {
        cookie: `boof_ui_4319=${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.details.reason).toBe("mcp_key_required");
  });

  it.each(["same-site", "cross-site"])(
    "a session cookie with Sec-Fetch-Site: %s is refused",
    async (site) => {
      const app = build();
      const { response } = await signIn(app);
      const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
      const res = await request(app, "/api/v1/whoami", {
        headers: { cookie: `boof_ui_4319=${token}`, "sec-fetch-site": site },
      });
      expect([401, 403]).toContain(res.status);
      if (res.status === 401)
        expect((await res.json()).error.details.reason).toBe("browser_session_required");
    },
  );

  it.each([
    "x-forwarded-for",
    "forwarded",
    "x-real-ip",
    "x-forwarded-host",
    "x-forwarded-proto",
    "via",
  ])("a session cookie with proxy header %s is refused", async (header) => {
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    const res = await request(app, "/api/v1/whoami", {
      headers: { cookie: `boof_ui_4319=${token}`, [header]: "127.0.0.1" },
    });
    expect(res.status).toBe(401);
  });

  it("a session cookie from a non-loopback peer is refused", async () => {
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    peer = "10.0.0.4";
    const res = await request(app, "/api/v1/whoami", {
      headers: { cookie: `boof_ui_4319=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("auth.mode required: a valid session cookie is ignored (401)", async () => {
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    await setMode("required");
    const res = await request(app, "/api/v1/whoami", {
      headers: { cookie: `boof_ui_4319=${token}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("/auth/browser is 404 for a non-loopback peer, with a proxy header, and in required mode", async () => {
    const app = build();
    const { code } = await sessions.createLink();
    peer = "10.0.0.4";
    expect((await request(app, `/auth/browser?code=${code}`)).status).toBe(404);
    peer = "127.0.0.1";
    expect(
      (await request(app, `/auth/browser?code=${code}`, { headers: { via: "proxy" } })).status,
    ).toBe(404);
    await setMode("required");
    expect((await request(app, `/auth/browser?code=${code}`)).status).toBe(404);
  });

  it("/auth/browser with a used or bad code is 400 M3 and spends the unauthenticated budget", async () => {
    await setMode("local-trust", 1);
    const app = build();
    const { code } = await sessions.createLink();
    expect((await request(app, `/auth/browser?code=${code}`)).status).toBe(303);
    const bad = await request(app, `/auth/browser?code=${code}`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("This sign-in link is invalid, used or expired");
    expect((await request(app, "/auth/browser?code=bad")).status).toBe(429);
  });

  it.skipIf(process.platform === "win32")(
    "an unsafe session store returns a permission-fix 503",
    async () => {
      const { code } = await sessions.createLink();
      await chmod(dataRootPaths(root).browserLinks, 0o666);
      const res = await request(build(), `/auth/browser?code=${code}`);
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toContain("Fix the data-root permissions");
      expect(body).toContain("chmod 600");
    },
  );

  it("cookie name follows the bound port: boof_ui_9999 does not sign in a server whose name is boof_ui_4319", async () => {
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    const res = await request(app, "/api/v1/whoami", {
      headers: { cookie: `boof_ui_9999=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("via a proxy Host on another port (Vite on 5319) the bound-port cookie still signs in", async () => {
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    const res = await request(app, "/api/v1/whoami", {
      headers: { cookie: `boof_ui_4319=${token}`, host: "127.0.0.1:5319" },
    });
    expect(res.status).toBe(200);
  });

  it("revokeAll ends an open /api/v1/events stream with event: unauthorized", async () => {
    watcher = new DataWatcher(root);
    watcher.start();
    const app = build();
    const { response } = await signIn(app);
    const token = response.headers.get("set-cookie")!.match(/^boof_ui_4319=([^;]+)/)![1];
    const stream = await request(app, "/api/v1/events", {
      headers: { cookie: `boof_ui_4319=${token}`, accept: "text/event-stream" },
    });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain("event: ready");
    await sessions.revokeAll();
    const until = Date.now() + 5000;
    while (!text.includes("event: unauthorized") && Date.now() < until) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE revoke timeout")), 5100),
        ),
      ]);
      if (next.done) break;
      text += decoder.decode(next.value);
    }
    expect(text).toContain("event: unauthorized");
    await reader.cancel();
  });

  it("Bearer keys behave as before from loopback and through a proxy", async () => {
    const key = (
      await authStore.create({ name: "test", scopes: ["projects:read"], trust: "trusted" })
    ).key;
    const app = build();
    expect(
      (await request(app, "/api/v1/whoami", { headers: { authorization: `Bearer ${key}` } }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(app, "/api/v1/whoami", {
          headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.2" },
        })
      ).status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("audit: sign-in writes auth:browser-session without the code; a keyless refusal records its reason", async () => {
    const app = build();
    const { code, response } = await signIn(app);
    expect(response.status).toBe(303);
    await request(app, "/api/v1/whoami");
    const lines = await auditLines();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "auth:browser-session", status: 303 }),
        expect.objectContaining({ reason: "browser_session_required", status: 401 }),
      ]),
    );
    expect(JSON.stringify(lines)).not.toContain(code);
  });
});
