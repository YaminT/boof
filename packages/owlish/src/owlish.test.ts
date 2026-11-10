import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwlishClient, OwlishError } from "./owlish.js";
import {
  defaultSettings,
  OwlishSettingsSchema,
  parseOwlishGatewayUrl,
  RetrySettingsSchema,
  SettingsSchema,
} from "@boof/heart";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
let server: Server;
let seen: Seen[];
/** What the fake gateway answers next: [status, body-text]. */
let reply: (req: Seen) => [number, string];
let url: string;

beforeEach(async () => {
  seen = [];
  reply = () => [200, "{}"];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const r: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(r);
      const [status, body] = reply(r);
      res
        .writeHead(
          status,
          status === 307
            ? { location: "https://redirect.test/collect", "content-type": "application/json" }
            : { "content-type": "application/json" },
        )
        .end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const HEALTH_OK = {
  status: "ok",
  pool: {
    configured: 3,
    routable: 2,
    paused: 0,
    rate_limited: 1,
    usage_exhausted: 0,
    next_available_at: null,
  },
};

describe("settings", () => {
  it("has no owlish by default and validates the gate", () => {
    expect(defaultSettings().owlish).toBeUndefined();
    const ok = OwlishSettingsSchema.parse({ url: "http://127.0.0.1:8080" });
    expect(ok.healthGate).toBe("pause");
    for (const g of ["pause", "warn", "off"]) {
      expect(OwlishSettingsSchema.parse({ url: "https://x:1", healthGate: g }).healthGate).toBe(g);
    }
    expect(() => OwlishSettingsSchema.parse({ url: "https://x:1", healthGate: "block" })).toThrow();
    expect(() => OwlishSettingsSchema.parse({ url: "ftp://x" })).toThrow();
    expect(() => OwlishSettingsSchema.parse({ url: "not a url" })).toThrow(
      /URL|HTTPS|credentials/i,
    );
    expect(() => OwlishSettingsSchema.parse({ url: "https://x:1", extra: 1 })).toThrow();
    for (const bad of [
      "http://user:pass@localhost:8080",
      "http://example.com",
      "https://x.test/?q=1",
      "https://x.test/#frag",
      "http://127.0.0.1:8080?",
      "http://127.0.0.1:8080/has space",
      'https://127.0.0.1",query_params={probe="injected"},zz="y',
      "https://bad_host.example",
      "https://bad=host.example",
    ]) {
      expect(() => OwlishSettingsSchema.parse({ url: bad })).toThrow();
    }
    expect(() =>
      OwlishSettingsSchema.parse({
        url: 'https://127.0.0.1",query_params={probe="injected"},zz="y',
      }),
    ).toThrow(/ASCII DNS hostname or bracketed IPv6/i);
    expect(parseOwlishGatewayUrl('http://127.0.0.1:8080/"unsafe')?.href).toBe(
      "http://127.0.0.1:8080/%22unsafe",
    );
    for (const good of ["http://[::1]:8080", "http://localhost.:8080"]) {
      expect(OwlishSettingsSchema.parse({ url: good }).url).toBe(good);
      expect(parseOwlishGatewayUrl(good)).not.toBeNull();
    }
    expect(parseOwlishGatewayUrl("https://xn--bcher-kva.example")).not.toBeNull();
    expect(parseOwlishGatewayUrl("https://[2001:db8::1]")).not.toBeNull();
    const s = SettingsSchema.parse({ ...defaultSettings(), owlish: { url: "https://x:1" } });
    expect(s.owlish?.url).toBe("https://x:1");
  });

  it("poolWaitMs defaults to 30 minutes and must be positive", () => {
    expect(RetrySettingsSchema.parse({}).poolWaitMs).toBe(30 * 60_000);
    expect(RetrySettingsSchema.parse({ poolWaitMs: 5000 }).poolWaitMs).toBe(5000);
    expect(() => RetrySettingsSchema.parse({ poolWaitMs: 0 })).toThrow();
    expect(() => RetrySettingsSchema.parse({ poolWaitMs: -1 })).toThrow();
  });
});

describe("OwlishClient.health", () => {
  it("refuses redirects so the client key cannot follow a redirect", async () => {
    const redirected: string[] = [];
    const second = createServer((req, res) => {
      redirected.push(req.url ?? "");
      res.end("{}");
    });
    await new Promise<void>((r) => second.listen(0, "127.0.0.1", r));
    const target = `http://127.0.0.1:${(second.address() as AddressInfo).port}/collect`;
    reply = () => [307, "{}"];
    // Redirect response points to a second local fake server.
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
      res.writeHead(307, { location: target }).end();
    });
    try {
      await expect(new OwlishClient({ url, apiKey: "btr-sensitive" }).accounts()).rejects.toThrow();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers["x-api-key"]).toBe("btr-sensitive");
      expect(redirected).toEqual([]);
    } finally {
      await new Promise<void>((r) => second.close(() => r()));
    }
  });
  it("reads the pool counts of a healthy gateway; /health is sent without the key", async () => {
    reply = () => [200, JSON.stringify(HEALTH_OK)];
    const h = await new OwlishClient({ url, apiKey: "btr-secret" }).health();
    expect(h).toEqual({
      status: "ok",
      configured: 3,
      routable: 2,
      paused: 0,
      rateLimited: 1,
      usageExhausted: 0,
      nextAvailableAt: null,
      reason: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/health" });
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("maps 503 degraded and unhealthy, with the next availability", async () => {
    reply = () => [
      503,
      JSON.stringify({
        status: "degraded",
        pool: {
          configured: 3,
          routable: 0,
          paused: 1,
          rate_limited: 2,
          usage_exhausted: 0,
          next_available_at: "2026-11-04T00:00:00Z",
        },
      }),
    ];
    const h = await new OwlishClient({ url }).health();
    expect(h).toMatchObject({
      status: "degraded",
      routable: 0,
      nextAvailableAt: "2026-11-04T00:00:00.000Z",
    });
    expect(h.reason).toMatch(/degraded/);
    reply = () => [
      503,
      JSON.stringify({ status: "unhealthy", pool: { configured: 0, routable: 0 } }),
    ];
    const u = await new OwlishClient({ url }).health();
    expect(u.status).toBe("unhealthy");
    expect(u.reason).toMatch(/unhealthy/);
  });

  it("tolerates unknown fields, and a 200 whose routable count is zero is degraded", async () => {
    reply = () => [
      200,
      JSON.stringify({
        ...HEALTH_OK,
        future: { a: 1 },
        pool: { ...HEALTH_OK.pool, routable: 0, extra: "x" },
      }),
    ];
    const h = await new OwlishClient({ url }).health();
    expect(h.status).toBe("degraded");
    expect(h.routable).toBe(0);
  });

  it("malformed bodies and wrong types normalize to a bounded status", async () => {
    for (const body of [
      "not json",
      "[]",
      "null",
      '"ok"',
      JSON.stringify({ status: 7 }),
      "x".repeat(100_000),
    ]) {
      reply = () => [200, body];
      const h = await new OwlishClient({ url }).health();
      expect(["unhealthy", "unreachable", "degraded"], body.slice(0, 20)).toContain(h.status);
      expect((h.reason ?? "").length).toBeLessThanOrEqual(200);
      expect(h.configured).toBeNull();
    }
    reply = () => [
      200,
      JSON.stringify({
        status: "ok",
        pool: { configured: "many", routable: -3, paused: 1.5, next_available_at: "soon" },
      }),
    ];
    const h = await new OwlishClient({ url }).health();
    expect(h).toMatchObject({
      configured: null,
      routable: null,
      paused: null,
      nextAvailableAt: null,
    });
  });

  it("an HTTP error without a status body is unhealthy; a refused connection is unreachable", async () => {
    reply = () => [500, "boom"];
    expect((await new OwlishClient({ url }).health()).status).toBe("unhealthy");
    const dead = new OwlishClient({ url: "http://127.0.0.1:1" });
    const h = await dead.health();
    expect(h.status).toBe("unreachable");
    expect(h.reason).toMatch(/unreachable/);
    expect(h.reason).not.toMatch(/btr-/);
  });

  it("a hung gateway times out as unreachable", async () => {
    reply = () => [200, JSON.stringify(HEALTH_OK)];
    const slow = new OwlishClient({
      url,
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
    });
    expect((await slow.health()).status).toBe("unreachable");
  });

  it("caches the result for 10 seconds, failures included", async () => {
    let t = 1_000_000;
    reply = () => [200, JSON.stringify(HEALTH_OK)];
    const c = new OwlishClient({ url, now: () => t });
    await c.health();
    t += 9_000;
    await c.health();
    expect(seen).toHaveLength(1);
    t += 2_000;
    await c.health();
    expect(seen).toHaveLength(2);
    const dead = new OwlishClient({ url: "http://127.0.0.1:1", now: () => t });
    await dead.health();
    t += 5_000;
    expect((await dead.health()).status).toBe("unreachable"); // cached, no second connect attempt
  });
});

describe("OwlishClient.agentSdkEligibility", () => {
  it("uses the account list and client key", async () => {
    reply = () => [
      200,
      JSON.stringify([
        { id: "a", name: "console", provider: "claude-console-api", hasRefreshToken: false },
      ]),
    ];
    const result = await new OwlishClient({ url, apiKey: "btr-secret" }).agentSdkEligibility();
    expect(result).toMatchObject({ gateway: "checked", allowed: true });
    expect(seen[0]?.headers["x-api-key"]).toBe("btr-secret");
  });
  it("maps HTTP, malformed and unreachable errors without throwing", async () => {
    reply = () => [401, "{}"];
    expect((await new OwlishClient({ url }).agentSdkEligibility()).reason).toContain("HTTP 401");
    reply = () => [200, "not json"];
    expect((await new OwlishClient({ url }).agentSdkEligibility()).reason).toContain(
      "malformed answer",
    );
    reply = () => [
      200,
      JSON.stringify([
        { id: "known", name: "console", provider: "claude-console-api" },
        { nope: true },
      ]),
    ];
    expect((await new OwlishClient({ url }).agentSdkEligibility()).reason).toContain(
      "malformed answer",
    );
    const dead = new OwlishClient({ url: "http://127.0.0.1:1" });
    expect((await dead.agentSdkEligibility()).reason).toContain("unreachable");
  });
  it.each([
    [
      "wrapped object",
      {
        accounts: [{ id: "a", name: "ok", provider: "claude-console-api", hasRefreshToken: false }],
      },
    ],
    [
      "pagination field",
      {
        accounts: [{ id: "a", name: "ok", provider: "claude-console-api", hasRefreshToken: false }],
        nextCursor: "p2",
      },
    ],
    ["error field", { accounts: [], error: "partial" }],
    [
      "renamed refresh field",
      [{ id: "a", name: "ok", provider: "claude-console-api", has_refresh_token: false }],
    ],
    ["missing refresh field", [{ id: "a", name: "ok", provider: "claude-console-api" }]],
    [
      "string refresh field",
      [{ id: "a", name: "ok", provider: "claude-console-api", hasRefreshToken: "true" }],
    ],
    [
      "numeric refresh field",
      [{ id: "a", name: "ok", provider: "claude-console-api", hasRefreshToken: 1 }],
    ],
    ["missing provider", [{ id: "a", name: "ok", hasRefreshToken: false }]],
    ["empty provider", [{ id: "a", name: "ok", provider: "", hasRefreshToken: false }]],
  ])("closes on non-v3.6.3 response shape: %s", async (_label, body) => {
    reply = () => [200, JSON.stringify(body)];
    expect((await new OwlishClient({ url }).agentSdkEligibility()).allowed).toBe(false);
    expect((await new OwlishClient({ url }).agentSdkEligibility()).reason).toContain(
      "malformed answer",
    );
  });
});

describe("OwlishClient accounts", () => {
  const account = {
    id: "a1",
    name: "Main",
    provider: "claude-oauth",
    priority: 0,
    paused: false,
    tokenStatus: "valid",
    rateLimitStatus: "ok",
    rateLimitReset: null,
    future: { x: 1 },
  };

  it("lists accounts with the key, keeping unknown fields; accepts a bare array or {accounts}", async () => {
    reply = () => [200, JSON.stringify([account])];
    const c = new OwlishClient({ url, apiKey: "btr-secret" });
    const list = await c.accounts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "a1",
      name: "Main",
      provider: "claude-oauth",
      priority: 0,
      paused: false,
    });
    expect((list[0] as Record<string, unknown>).future).toEqual({ x: 1 });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/accounts" });
    expect(seen[0]!.headers["x-api-key"]).toBe("btr-secret");
    reply = () => [200, JSON.stringify({ accounts: [account, { nope: true }, 5] })];
    expect((await c.accounts()).map((a) => a.id)).toEqual(["a1"]);
    // Lenient, as before 8b: a body that is no list is an empty list (only the gate is strict).
    reply = () => [200, JSON.stringify({ unexpected: true })];
    expect(await c.accounts()).toEqual([]);
  });

  it("pause, resume, priority and thresholds use the documented routes", async () => {
    reply = () => [200, "{}"];
    const c = new OwlishClient({ url, apiKey: "btr-secret" });
    await c.pause("a 1/2");
    await c.resume("a1");
    await c.setPriority("a1", 7);
    await c.setThresholds("a1", { fiveHour: 80, weekly: null });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/accounts/a%201%2F2/pause",
      "POST /api/accounts/a1/resume",
      "POST /api/accounts/a1/priority",
      "POST /api/accounts/a1/usage-pause-thresholds",
    ]);
    expect(JSON.parse(seen[2]!.body)).toEqual({ priority: 7 });
    expect(JSON.parse(seen[3]!.body)).toEqual({ fiveHour: 80, weekly: null });
    for (const s of seen) {
      expect(s.headers["x-api-key"]).toBe("btr-secret");
      expect(s.headers["content-type"]).toContain("application/json");
    }
  });

  it("rejects a priority outside 0-100 before any request", async () => {
    const c = new OwlishClient({ url });
    await expect(c.setPriority("a1", 101)).rejects.toThrow(OwlishError);
    await expect(c.setPriority("a1", 1.5)).rejects.toThrow(OwlishError);
    expect(seen).toHaveLength(0);
  });

  it("HTTP errors become OwlishError with the status and never the key or the body", async () => {
    reply = () => [401, JSON.stringify({ error: "API key required btr-secret" })];
    const c = new OwlishClient({ url, apiKey: "btr-secret" });
    const err = await c.accounts().catch((e) => e);
    expect(err).toBeInstanceOf(OwlishError);
    expect((err as OwlishError).status).toBe(401);
    expect(String((err as Error).message)).not.toContain("btr-secret");
    const down = await new OwlishClient({ url: "http://127.0.0.1:1", apiKey: "btr-secret" })
      .pause("a1")
      .catch((e) => e);
    expect(down).toBeInstanceOf(OwlishError);
    expect((down as OwlishError).status).toBeNull();
    expect(String((down as Error).message)).not.toContain("btr-secret");
  });

  it("probeAdminRoute treats 401 and 403 as rejected, 2xx as accepted, and the rest as unknown", async () => {
    const probe = (status: number) => {
      reply = () => [status, "{}"];
      return new OwlishClient({ url, apiKey: "btr-agent" }).probeAdminRoute();
    };
    expect(await probe(401)).toBe("rejected");
    expect(await probe(403)).toBe("rejected");
    expect(await probe(200)).toBe("accepted");
    expect(await probe(204)).toBe("accepted");
    expect(await probe(500)).toBe("unknown");
    expect(await probe(307)).toBe("unknown");
    expect(
      await new OwlishClient({
        url: "http://127.0.0.1:1",
        apiKey: "btr-agent",
        timeoutMs: 200,
      }).probeAdminRoute(),
    ).toBe("unknown");
  });

  it("a mutation clears the cached health", async () => {
    let t = 1;
    reply = (r) => [200, r.url === "/health" ? JSON.stringify(HEALTH_OK) : "{}"];
    const c = new OwlishClient({ url, now: () => t });
    await c.health();
    await c.pause("a1");
    await c.health();
    expect(seen.filter((s) => s.url === "/health")).toHaveLength(2);
  });
});
