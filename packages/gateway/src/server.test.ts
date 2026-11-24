import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountsStore } from "./accounts-store.js";
import { Pool } from "./pool.js";
import { GatewayServer, type GatewayLogEvent } from "./server.js";
import { TokenStore } from "./tokens.js";

const KEY_A = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA";
const KEY_B = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBB";
const PROMPT = "super-secret-prompt-text";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;

let root: string;
let upstream: http.Server;
let upstreamPort: number;
let seen: Seen[];
let handler: Handler;
let pool: Pool;
let tokens: TokenStore;
let gw: GatewayServer;
let base: { port: number; url: string };
let token: string;
let logs: GatewayLogEvent[];
let consoleOut: string[];
let origConsole: Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(
  opts: Partial<ConstructorParameters<typeof GatewayServer>[0]> = {},
  keys = [KEY_A, KEY_B],
) {
  let i = 0;
  pool = await Pool.open({
    store: new AccountsStore(join(root, "gateway")),
    newId: () => ["a", "b", "c"][i++]!,
  });
  for (const [n, k] of keys.entries()) await pool.add({ name: `n${n}`, apiKey: k, priority: n });
  tokens = new TokenStore();
  token = tokens.mint({ runId: "run1", ttlMs: 60_000 });
  gw = new GatewayServer({
    pool,
    tokens,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    log: (e) => logs.push(e),
    ...opts,
  });
  base = await gw.start();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gateway-server-"));
  seen = [];
  logs = [];
  consoleOut = [];
  origConsole = {};
  for (const m of ["log", "error", "warn", "info"] as const) {
    origConsole[m] = console[m];
    console[m] = (...a: unknown[]) => void consoleOut.push(a.join(" "));
  }
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 } }));
  };
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(s);
      handler(req, res, s);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterEach(async () => {
  for (const m of ["log", "error", "warn", "info"] as const) {
    (console as unknown as Record<string, unknown>)[m] = origConsole[m];
  }
  await gw?.stop();
  await pool?.flush();
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function call(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  auth?: boolean;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.auth !== false) headers["x-api-key"] ??= token;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: base.port,
        method: opts.method ?? "POST",
        path: opts.path ?? "/v1/messages",
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const method = opts.method ?? "POST";
    req.end(
      opts.body ??
        (method === "GET"
          ? undefined
          : JSON.stringify({ model: "m", messages: [{ role: "user", content: PROMPT }] })),
    );
  });
}

/** Raw request line + headers, for targets and Host values http.request refuses to send. */
function raw(text: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(base.port, "127.0.0.1", () => s.write(text));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => s.destroy(), 1500).unref();
  });
}

describe("Proxy guards", () => {
  it("rejects a non-loopback Host (DNS rebinding)", async () => {
    await boot();
    const r = await call({ headers: { host: "evil.example.com" } });
    expect(r.status).toBe(421);
    const r2 = await call({ headers: { host: `localhost:${base.port}` } });
    expect(r2.status).toBe(421);
    expect(seen).toHaveLength(0);
  });

  it("rejects any request with an Origin header", async () => {
    await boot();
    expect((await call({ headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("requires a live run token (missing, wrong, revoked, expired)", async () => {
    await boot();
    expect((await call({ auth: false })).status).toBe(401);
    expect((await call({ headers: { "x-api-key": "bgw_nope" } })).status).toBe(401);
    expect((await call({ headers: { "x-api-key": KEY_A } })).status).toBe(401);
    expect(
      (await call({ auth: false, headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    tokens.revoke(token);
    expect((await call({})).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("refuses absolute-form targets, CONNECT and unknown paths or methods", async () => {
    await boot();
    const abs = await raw(
      `POST http://example.com/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${base.port}\r\nx-api-key: ${token}\r\ncontent-length: 0\r\n\r\n`,
    );
    expect(abs).toMatch(/^HTTP\/1.1 400/);
    const con = await raw(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`);
    expect(con).toMatch(/^HTTP\/1.1 405/);
    const dbl = await raw(
      `POST //example.com/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${base.port}\r\nx-api-key: ${token}\r\ncontent-length: 0\r\n\r\n`,
    );
    expect(dbl).toMatch(/^HTTP\/1.1 400/);
    expect((await call({ path: "/v1/complete" })).status).toBe(404);
    expect((await call({ path: "/v1/messages/../models" })).status).toBe(404);
    expect((await call({ path: "/v1/messages/batches" })).status).toBe(404);
    expect((await call({ method: "GET", path: "/v1/messages" })).status).toBe(405);
    expect((await call({ method: "DELETE", path: "/v1/messages", body: "" })).status).toBe(405);
    expect((await call({ method: "POST", path: "/v1/models", body: "" })).status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it("answers 413 above the body cap, by Content-Length and when streamed", async () => {
    await boot({ maxBodyBytes: 1024 });
    const r = await call({ body: "x".repeat(2048) });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).error.type).toBe("request_too_large");
    expect((await call({ body: "y".repeat(1024) })).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("never forwards incoming credentials; upstream sees exactly the account key", async () => {
    await boot();
    await call({
      headers: {
        authorization: "Bearer sk-ant-api03-ATTACKERKEYATTACKERKEY",
        cookie: "sid=1",
        "proxy-authorization": "x",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "b1",
        "x-stainless-lang": "js",
        "x-claude-code-session-id": "s",
        "x-forwarded-for": "9.9.9.9",
        "content-type": "application/json",
        "accept-encoding": "gzip",
      },
    });
    const h = seen[0]!.headers;
    expect(h["x-api-key"]).toBe(KEY_A);
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(h["proxy-authorization"]).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
    expect(h["accept-encoding"]).toBe("identity");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["anthropic-beta"]).toBe("b1");
    expect(h["x-stainless-lang"]).toBe("js");
    expect(h["x-claude-code-session-id"]).toBe("s");
    expect(h.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it("only talks to the fixed upstream path, keeping a ?beta=true query", async () => {
    await boot();
    await call({ path: "/v1/messages?beta=true" });
    await call({ method: "GET", path: "/v1/models" });
    expect(seen.map((s) => s.url)).toEqual(["/v1/messages?beta=true", "/v1/models"]);
  });

  it("does not pass organization ids or cookies back", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "a=b",
        "anthropic-organization-id": "org",
        "anthropic-ratelimit-requests-remaining": "9",
        "request-id": "req_1",
      });
      res.end("{}");
    };
    const r = await call({});
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["anthropic-organization-id"]).toBeUndefined();
    expect(r.headers["anthropic-ratelimit-requests-remaining"]).toBe("9");
    expect(r.headers["request-id"]).toBe("req_1");
  });

  it("binds loopback only", async () => {
    await boot();
    const addr = (gw as unknown as { server: net.Server }).server.address() as net.AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("keeps keys, tokens and prompts out of logs, console and errors", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
    };
    await call({});
    upstream.closeAllConnections();
    const dead = new GatewayServer({
      pool,
      tokens,
      upstreamOrigin: "http://127.0.0.1:1",
      log: (e) => logs.push(e),
    });
    const d = await dead.start();
    const t2 = tokens.mint({ runId: "r2", ttlMs: 60_000 });
    await new Promise<void>((resolve) => {
      const rq = http.request(
        {
          host: "127.0.0.1",
          port: d.port,
          method: "POST",
          path: "/v1/messages",
          headers: { "x-api-key": t2 },
          agent: false,
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve());
        },
      );
      rq.end(PROMPT);
    });
    await dead.stop();
    const all = JSON.stringify(logs) + consoleOut.join("\n");
    for (const secret of [KEY_A, KEY_B, token, t2, PROMPT]) expect(all).not.toContain(secret);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("Streaming", () => {
  it("delivers SSE chunks incrementally with no buffering", async () => {
    await boot();
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 9 } },
    ];
    handler = async (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      res.flushHeaders();
      for (const e of events) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
        await sleep(150);
      }
      res.end();
    };
    const stamps: number[] = [];
    const t0 = Date.now();
    const headersAt = await new Promise<number>((resolve, reject) => {
      const rq = http.request(
        {
          host: "127.0.0.1",
          port: base.port,
          method: "POST",
          path: "/v1/messages",
          headers: { "x-api-key": token },
          agent: false,
        },
        (r) => {
          const at = Date.now() - t0;
          expect(r.headers["content-encoding"]).toBeUndefined();
          expect(r.headers["content-type"]).toBe("text/event-stream");
          r.on("data", () => stamps.push(Date.now() - t0));
          r.on("end", () => resolve(at));
          r.on("error", reject);
        },
      );
      rq.end("{}");
    });
    expect(headersAt).toBeLessThan(140);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThan(100);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThan(100);
    await pool.flush();
    const req = logs.find((l) => l.event === "request");
    expect(req).toMatchObject({ accountId: "a", status: 200, inputTokens: 11, outputTokens: 9 });
  });

  it("aborts the upstream request when the client disconnects", async () => {
    await boot();
    let upstreamClosed = false;
    handler = (_q, res) => {
      res.on("close", () => (upstreamClosed = true));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
    };
    await new Promise<void>((resolve) => {
      const rq = http.request(
        {
          host: "127.0.0.1",
          port: base.port,
          method: "POST",
          path: "/v1/messages",
          headers: { "x-api-key": token },
          agent: false,
        },
        (r) => {
          r.once("data", () => {
            rq.destroy();
            resolve();
          });
        },
      );
      rq.on("error", () => {});
      rq.end("{}");
    });
    for (let i = 0; i < 40 && !upstreamClosed; i++) await sleep(50);
    expect(upstreamClosed).toBe(true);
  });

  it("aborts the response when the upstream drops mid-stream, without retrying", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n');
      setTimeout(() => res.destroy(), 50);
    };
    // The client must see a failure, not a clean end that looks like a complete response.
    await expect(call({})).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("gives up on a stalled stream after the idle timeout", async () => {
    await boot({ idleTimeoutMs: 100 });
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
    };
    await expect(call({})).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("counts usage from a JSON response into the pool", async () => {
    await boot();
    await call({});
    expect(logs.find((l) => l.event === "request")).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
    });
  });
});

describe("Limits", () => {
  it("answers 429 when too many body bytes are being received, and frees them after", async () => {
    await boot({ maxInflightBodyBytes: 100, maxRunInflightBodyBytes: 100 });
    const sock = net.connect(base.port, "127.0.0.1");
    sock.on("error", () => {});
    sock.write(
      `POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:${base.port}\r\nx-api-key: ${token}\r\ncontent-length: 80\r\n\r\n${"x".repeat(60)}`,
    );
    await sleep(50);
    const second = await call({ body: "x".repeat(80) });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBe("1");
    sock.destroy();
    await sleep(300);
    expect((await call({ body: "x".repeat(80) })).status).toBe(200);
  });

  it("pipelined requests on dying sockets give the reservation back", async () => {
    await boot({ maxInflightBodyBytes: 1000, maxBodyBytes: 600 });
    handler = (_q, res) => setTimeout(() => res.end("{}"), 200);
    const raw = (len: number, body: string) =>
      `POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:${base.port}\r\nx-api-key: ${token}\r\n` +
      `content-length: ${len}\r\n\r\n${body}`;
    const socks: net.Socket[] = [];
    for (let i = 0; i < 6; i++) {
      const sock = net.connect(base.port, "127.0.0.1");
      sock.on("error", () => {});
      sock.write(raw(2, "{}") + raw(500, "x".repeat(10)));
      socks.push(sock);
    }
    await sleep(60);
    for (const sock of socks) sock.destroy();
    await sleep(300);
    expect((gw as unknown as { inflight: number }).inflight).toBe(0);
    expect((await call({ body: "x".repeat(400) })).status).toBe(200);
  });

  it("counts received bytes, not the declared length, and caps one run's share", async () => {
    await boot({ maxInflightBodyBytes: 1000, maxBodyBytes: 600, maxRunInflightBodyBytes: 300 });
    const sock = net.connect(base.port, "127.0.0.1");
    sock.on("error", () => {});
    sock.write(
      `POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:${base.port}\r\nx-api-key: ${token}\r\ncontent-length: 600\r\n\r\n`,
    );
    await sleep(50);
    // declared 600 but nothing sent: another run still gets in
    const other = tokens.mint({ runId: "run2", ttlMs: 60_000 });
    const r = await call({ body: "x".repeat(200), headers: { "x-api-key": other } });
    expect(r.status).toBe(200);
    // one run cannot hold more than its share
    const big = await call({ body: "x".repeat(400) });
    expect(big.status).toBe(429);
    sock.destroy();
  });

  it("keeps counting a fully uploaded body while the upstream has not answered", async () => {
    await boot({ maxInflightBodyBytes: 1000, maxBodyBytes: 600, maxRunInflightBodyBytes: 300 });
    let release: (() => void) | undefined;
    handler = (_q, res) => {
      release = () => res.end("{}");
    };
    const first = call({ body: "x".repeat(250) }).catch(() => undefined);
    await sleep(150);
    // the first body is fully uploaded but still held in memory: it must still count
    const second = await call({ body: "x".repeat(250) });
    expect(second.status).toBe(429);
    release?.();
    await first;
    await sleep(100);
    expect((gw as unknown as { inflight: number }).inflight).toBe(0);
  });

  it("ends a stream when its token is revoked mid-response", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      setTimeout(() => res.write("data: {}\n\n"), 100);
    };
    const pending = call({});
    await sleep(40);
    tokens.revokeRun("run1");
    await expect(pending).rejects.toThrow();
  });
});

describe("Failover", () => {
  const notFoundEcho: Handler = (q, res) => {
    void q;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "not_found_error", message: "model: claude-x reached your specified limit" },
      }),
    );
  };

  it("a 404 that echoes client text never pauses or exhausts an account", async () => {
    await boot();
    handler = notFoundEcho;
    const r = await call({
      body: JSON.stringify({ model: "claude-x reached your specified limit" }),
    });
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(1);
    expect(pool.status().status).toBe("ok");
  });

  it("keeps failing over but marks at most two accounts per request, then answers 429 retry-after 1", async () => {
    await boot({}, [KEY_A, KEY_B, "sk-ant-api03-CCCCCCCCCCCCCCCCCCCC"]);
    handler = (_q, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "billing_error", message: "x" } }));
    };
    const r = await call({});
    expect(seen).toHaveLength(3);
    expect(pool.status().usageExhausted).toBe(2);
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("1");
  });

  it("A and B out of credit, C fine: C serves the request", async () => {
    await boot({}, [KEY_A, KEY_B, "sk-ant-api03-CCCCCCCCCCCCCCCCCCCC"]);
    handler = (q, res) => {
      if (q.headers["x-api-key"] === "sk-ant-api03-CCCCCCCCCCCCCCCCCCCC") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{}");
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Your credit balance is too low" },
        }),
      );
    };
    const r = await call({});
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  it("limits what a client can shape: version and OAuth betas are not forwarded", async () => {
    await boot();
    await call({
      headers: {
        "anthropic-version": "1999-01-01",
        "anthropic-beta": "oauth-2025-04-20, claude-code-20250219",
      },
    });
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219");
  });

  it("a 403 passes through without pausing", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "permission_error", message: "no" } }),
      );
    };
    const r = await call({});
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(pool.status().paused).toBe(0);
  });

  const rate = (retry = "30") =>
    ((_q, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": retry });
      res.end(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } }),
      );
    }) as Handler;

  it("429 on account A: the same request body succeeds on B, and A is paused", async () => {
    await boot();
    handler = (q, res, s) =>
      s.headers["x-api-key"] === KEY_A
        ? rate()(q, res, s)
        : (res.writeHead(200, { "content-type": "application/json" }), res.end("{}"));
    const r = await call({});
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.headers["x-api-key"])).toEqual([KEY_A, KEY_B]);
    expect(seen[1]!.body).toBe(seen[0]!.body);
    expect(pool.status().rateLimited).toBe(1);
    // next request goes straight to B
    await call({});
    expect(seen[2]!.headers["x-api-key"]).toBe(KEY_B);
  });

  it("401 pauses the account (auth) and fails over", async () => {
    await boot();
    handler = (_q, res, s) => {
      if (s.headers["x-api-key"] === KEY_A) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "bad" },
          }),
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    };
    expect((await call({})).status).toBe(200);
    expect(pool.accountList()[0]).toMatchObject({ paused: true, pauseReason: "auth" });
  });

  it("a 401 the key does not repeat on GET /v1/models does not pause the account", async () => {
    await boot();
    const auth401 = (res: http.ServerResponse) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x" } }),
      );
    };
    // The messages request is refused (its shape), the key itself is fine.
    handler = (q, res) =>
      q.url === "/v1/models" ? (res.writeHead(200), res.end("{}")) : auth401(res);
    const r = await call({});
    expect(r.status).toBe(401);
    expect(pool.accountList().every((a) => !a.paused)).toBe(true);
    const check = seen.find((x) => x.url === "/v1/models")!;
    expect(Object.keys(check.headers).sort()).toEqual(
      ["accept-encoding", "anthropic-version", "connection", "host", "x-api-key"].sort(),
    );
    expect(check.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("a hung 401 re-check is bounded by the re-check budget", async () => {
    await boot({ recheckBudgetMs: 150 });
    handler = (q, res) => {
      if (q.url === "/v1/models") return; // never answers
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x" } }),
      );
    };
    const t0 = Date.now();
    const r = await call({});
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.status).toBe(401);
    expect(pool.accountList().every((a) => !a.paused)).toBe(true);
  });

  it("a credit error marks the account out of credit and fails over", async () => {
    await boot();
    handler = (_q, res, s) => {
      if (s.headers["x-api-key"] === KEY_A) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "You have reached your specified API usage limits.",
            },
          }),
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    };
    expect((await call({})).status).toBe(200);
    expect(pool.status().usageExhausted).toBe(1);
  });

  it("all accounts limited: 429 with an Anthropic-shaped body and retry-after", async () => {
    await boot();
    handler = rate("45");
    const r = await call({});
    expect(r.status).toBe(429);
    expect(JSON.parse(r.body)).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    });
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(r.headers["retry-after"])).toBeLessThanOrEqual(45);
    expect(seen).toHaveLength(2);
    // pool now empty of routable accounts: no upstream call at all
    const again = await call({});
    expect(again.status).toBe(429);
    expect(seen).toHaveLength(2);
  });

  it("no accounts at all: 429 and nothing reaches upstream", async () => {
    await boot({}, []);
    const r = await call({});
    expect(r.status).toBe(429);
    expect(seen).toHaveLength(0);
  });

  it("does not retry after the first byte went to the client", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      setTimeout(() => res.destroy(), 30);
    };
    await call({}).catch(() => {});
    await sleep(100);
    expect(seen).toHaveLength(1);
    expect(pool.status().routable).toBe(2);
  });

  it("5xx: one retry on another account, then pass through; the account is not faulted", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(529, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
      );
    };
    const r = await call({});
    expect(r.status).toBe(529);
    expect(JSON.parse(r.body).error.type).toBe("overloaded_error");
    expect(seen).toHaveLength(2);
    expect(pool.status().routable).toBe(2);
  });

  it("5xx with a single account passes through after one attempt", async () => {
    await boot({}, [KEY_A]);
    handler = (_q, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "x" } }));
    };
    expect((await call({})).status).toBe(500);
    expect(seen).toHaveLength(1);
  });

  it("other 4xx is the request's fault: passed through, no failover", async () => {
    await boot();
    handler = (_q, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "bad field" },
        }),
      );
    };
    const r = await call({});
    expect(r.status).toBe(400);
    expect(r.body).toContain("bad field");
    expect(seen).toHaveLength(1);
  });

  it("an unreachable upstream retries once on another account, then answers 502", async () => {
    await boot({ upstreamOrigin: "http://127.0.0.1:1" });
    const r = await call({});
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error.type).toBe("api_error");
    expect(pool.status().routable).toBe(2);
  });

  it("a hung upstream hits the header timeout", async () => {
    await boot({ headersTimeoutMs: 100 }, [KEY_A]);
    handler = () => {};
    const r = await call({});
    expect(r.status).toBe(502);
  });
});
