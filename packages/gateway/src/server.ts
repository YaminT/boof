import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { classify, type Outcome } from "./limits.js";
import { ConnectProxyAgent, proxyFromEnv } from "./proxy-agent.js";
import type { Pool } from "./pool.js";
import { redactSecrets } from "./redact.js";
import type { TokenStore } from "./tokens.js";
import { UsageTap } from "./usage-tap.js";

/** The only upstream. Tests may point `upstreamOrigin` at a fake; it is not a setting. */
export const UPSTREAM_ORIGIN = "https://api.anthropic.com";
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** All request bodies being buffered at once, across tokens. */
export const MAX_INFLIGHT_BODY_BYTES = 128 * 1024 * 1024;
const KNOWN_VERSIONS = new Set(["2023-06-01"]);
const MAX_ATTEMPTS = 3;
/** Credit or auth answers one request may record against accounts. */
const MAX_MARKS_PER_REQUEST = 2;
const MAX_ERROR_BODY = 1024 * 1024;

type Route = { methods: string[]; usage: boolean };
const ROUTES: Record<string, Route> = {
  "/v1/messages": { methods: ["POST"], usage: true },
  "/v1/messages/count_tokens": { methods: ["POST"], usage: false },
  "/v1/models": { methods: ["GET"], usage: false },
};

/** Request headers that are forwarded; everything else (auth, cookies, host, proxy-*) is dropped. */
const FORWARD_EXACT = new Set([
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "accept",
  "user-agent",
]);
const FORWARD_PREFIX = ["x-stainless-", "x-claude-code-"];
/** Response headers that are passed back. `anthropic-organization-id` and cookies are not. */
const RESPONSE_EXACT = new Set([
  "content-type",
  "cache-control",
  "retry-after",
  "retry-after-ms",
  "request-id",
  "x-request-id",
  "x-should-retry",
]);
const RESPONSE_DROP = new Set(["anthropic-organization-id", "anthropic-workspace-id"]);

/** Never carries a key, token or body text. */
export interface GatewayLogEvent {
  event: "request" | "failover" | "error";
  accountId?: string;
  runId?: string;
  status?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  message?: string;
}

export interface GatewayServerOptions {
  pool: Pool;
  tokens: TokenStore;
  now?: () => number;
  /** Tests only: a fake upstream origin. */
  upstreamOrigin?: string;
  /** Environment read for HTTPS_PROXY / NO_PROXY (D7). Default `process.env`; tests pass their own. */
  env?: Record<string, string | undefined>;
  maxBodyBytes?: number;
  /** Cap on request bytes held in memory at once; default 128 MiB. */
  maxInflightBodyBytes?: number;
  /** Cap on request bytes one run may hold at once; default 2 x maxBodyBytes (at most half the total). */
  maxRunInflightBodyBytes?: number;
  /** Time allowed to receive a whole request (headers and body); default 60 s. */
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (event: GatewayLogEvent) => void;
}

const isLoopback = (addr: string | undefined): boolean =>
  addr === "127.0.0.1" || addr === "::1" || (addr?.startsWith("::ffff:127.") ?? false);

function sendJson(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
  extra: OutgoingHttpHeaders = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
    ...extra,
  });
  res.end(body);
}

class TooLarge extends Error {}

class OverBudget extends Error {}

function readBody(
  req: IncomingMessage,
  max: number,
  take: (n: number) => boolean,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) return reject(new TooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        chunks.length = 0;
        reject(new TooLarge());
        req.pause();
        return;
      }
      // Count what actually arrived, not what the header promised.
      if (!take(c.length)) {
        chunks.length = 0;
        reject(new OverBudget());
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted")));
    req.on("close", () => reject(new Error("client closed")));
  });
}

type Upstream = { ok: true; res: IncomingMessage } | { ok: false; error: string };

interface Buffered {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  outcome: Outcome;
}

export class GatewayServer {
  private readonly pool: Pool;
  private readonly tokens: TokenStore;
  private readonly now: () => number;
  private readonly origin: URL;
  private readonly agent: http.Agent;
  private readonly maxBody: number;
  private readonly maxInflight: number;
  private inflight = 0;
  private readonly maxRunInflight: number;
  private readonly runInflight = new Map<string, number>();
  private readonly requestMs: number;
  private readonly connectMs: number;
  private readonly headersMs: number;
  private readonly idleMs: number;
  private readonly log: (e: GatewayLogEvent) => void;
  private server: http.Server | null = null;
  private port = 0;

  constructor(opts: GatewayServerOptions) {
    this.pool = opts.pool;
    this.tokens = opts.tokens;
    this.now = opts.now ?? Date.now;
    this.origin = new URL(opts.upstreamOrigin ?? UPSTREAM_ORIGIN);
    const proxy = proxyFromEnv(this.origin, opts.env ?? process.env);
    this.agent =
      this.origin.protocol === "https:"
        ? proxy
          ? new ConnectProxyAgent(proxy, { keepAlive: true }, opts.connectTimeoutMs)
          : new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
    this.maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    this.maxInflight = opts.maxInflightBodyBytes ?? MAX_INFLIGHT_BODY_BYTES;
    this.maxRunInflight =
      opts.maxRunInflightBodyBytes ?? Math.min(2 * this.maxBody, this.maxInflight / 2);
    this.requestMs = opts.requestTimeoutMs ?? 60_000;
    this.connectMs = opts.connectTimeoutMs ?? 10_000;
    this.headersMs = opts.headersTimeoutMs ?? 10 * 60_000;
    this.idleMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.log = opts.log ?? (() => {});
  }

  /** Listen on 127.0.0.1, random port. */
  async start(): Promise<{ port: number; url: string }> {
    if (this.server) throw new Error("gateway already started");
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.fail(err);
        sendJson(res, 502, "api_error", "Gateway error");
      });
    });
    server.requestTimeout = this.requestMs;
    server.headersTimeout = Math.min(this.requestMs, 60_000);
    server.on("connection", (socket: Socket) => {
      if (!isLoopback(socket.remoteAddress)) socket.destroy();
    });
    server.on("connect", (_req, socket) => {
      socket.end("HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\n\r\n");
    });
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return { port: this.port, url: `http://127.0.0.1:${this.port}` };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.agent.destroy();
    await this.pool.flush().catch(() => {});
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private fail(err: unknown, extra: Partial<GatewayLogEvent> = {}): void {
    const raw = err instanceof Error ? err.message : "error";
    this.log({
      event: "error",
      ...extra,
      message: redactSecrets(raw, this.pool.secrets()).slice(0, 200),
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Body bytes held for this request. Released once, by whichever comes first: the request
    // being finished with the body, or the response, request or socket ending or failing.
    let held = 0;
    let runId: string | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inflight -= held;
      if (runId !== undefined) {
        const left = (this.runInflight.get(runId) ?? 0) - held;
        if (left > 0) this.runInflight.set(runId, left);
        else this.runInflight.delete(runId);
      }
      held = 0;
    };
    const take = (n: number): boolean => {
      if (released) return false;
      const mine = runId === undefined ? 0 : (this.runInflight.get(runId) ?? 0);
      if (this.inflight + n > this.maxInflight || mine + n > this.maxRunInflight) return false;
      this.inflight += n;
      held += n;
      if (runId !== undefined) this.runInflight.set(runId, mine + n);
      return true;
    };
    res.once("close", release);
    req.once("error", release);
    req.socket.once("close", release);
    try {
      await this.serve(req, res, (id) => (runId = id), take);
    } finally {
      release();
    }
  }

  private async serve(
    req: IncomingMessage,
    res: ServerResponse,
    setRun: (id: string) => void,
    take: (n: number) => boolean,
  ): Promise<void> {
    const started = this.now();
    // Guards. Order: who is calling, then what they ask for.
    if (!isLoopback(req.socket.remoteAddress)) return void req.socket.destroy();
    if ((req.headers.host ?? "").toLowerCase() !== `127.0.0.1:${this.port}`) {
      return sendJson(res, 421, "invalid_request_error", "Misdirected request");
    }
    if (req.headers.origin !== undefined) {
      return sendJson(res, 403, "permission_error", "Browser requests are not allowed");
    }
    const target = req.url ?? "";
    if (!target.startsWith("/") || target.startsWith("//")) {
      return sendJson(res, 400, "invalid_request_error", "Bad request target");
    }
    const auth = req.headers.authorization;
    const supplied =
      (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined) ??
      (typeof auth === "string" && /^bearer /i.test(auth) ? auth.slice(7).trim() : undefined);
    const run = this.tokens.verify(supplied);
    if (!run) return sendJson(res, 401, "authentication_error", "Invalid or expired run token");
    setRun(run.runId);

    const q = target.indexOf("?");
    const path = q < 0 ? target : target.slice(0, q);
    const search = q < 0 ? "" : target.slice(q);
    const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (!route || !/^[\x21-\x7e]*$/.test(search) || search.includes("#")) {
      return sendJson(res, 404, "not_found_error", "Not found");
    }
    if (!route.methods.includes(req.method ?? "")) {
      return sendJson(res, 405, "invalid_request_error", "Method not allowed", {
        allow: route.methods.join(", "),
      });
    }

    let body: Buffer = Buffer.alloc(0);
    if (req.method === "POST") {
      try {
        body = await readBody(req, this.maxBody, take);
      } catch (err) {
        if (err instanceof TooLarge) {
          return sendJson(res, 413, "request_too_large", "Request body is too large");
        }
        if (err instanceof OverBudget) {
          return sendJson(res, 429, "rate_limit_error", "Too many requests in flight", {
            "retry-after": "1",
          });
        }
        return void req.socket.destroy();
      }
    }

    // Forward. A failed attempt moves to the next account only while nothing was sent back.
    let current: http.ClientRequest | undefined;
    res.on("close", () => {
      if (!res.writableEnded) current?.destroy();
    });
    const tried: string[] = [];
    const maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, this.pool.accountList().length));
    let transientRetried = false;
    let last: Buffered | undefined;
    let networkFailed = false;
    let marks = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (res.destroyed) return;
      const account = this.pool.pick(tried);
      if (!account) break;
      tried.push(account.id);
      const up = await this.send(path + search, req, body, account.apiKey, (r) => (current = r));
      if (!up.ok) {
        networkFailed = true;
        last = undefined;
        this.fail(new Error(up.error), { accountId: account.id, runId: run.runId });
        if (res.destroyed) return;
        if (transientRetried) break;
        transientRetried = true;
        continue;
      }
      networkFailed = false;
      const status = up.res.statusCode ?? 502;
      if (status < 400) {
        return this.stream(up.res, res, account.id, run.runId, route.usage, started, supplied);
      }
      const buffered = await this.bufferError(up.res);
      let outcome = classify(
        {
          status,
          headers: up.res.headers as Record<string, string | string[] | undefined>,
          body: buffered.toString("utf8"),
        },
        this.now(),
      );
      // R1: the 401 may come from the shape of this client's request, not from the key. Pause the
      // account only if a request the client cannot shape is refused too; otherwise the request was
      // at fault and the account stays in service.
      if (outcome.kind === "auth" && !(await this.keyRejected(account.apiKey))) {
        outcome = { kind: "other" };
      }
      // One request marks at most two accounts for credit/auth, but keeps trying the others.
      const marking = outcome.kind === "credit" || outcome.kind === "auth";
      if (!marking || marks < MAX_MARKS_PER_REQUEST) {
        this.pool.report(account.id, outcome, status);
        if (marking) marks++;
      }
      last = { status, headers: up.res.headers, body: buffered, outcome };
      this.log({
        event: "failover",
        accountId: account.id,
        runId: run.runId,
        status,
        durationMs: this.now() - started,
      });
      if (outcome.kind === "other") break;
      if (outcome.kind === "transient") {
        if (transientRetried) break;
        transientRetried = true;
      }
    }

    if (last && last.outcome.kind !== "other" && last.outcome.kind !== "transient") {
      // Every usable account failed: tell the client when the pool is back (429, Anthropic-shaped).
      if (this.pool.status().routable === 0) return this.exhausted(res);
      // Accounts are left, but this request used up its attempts: do not pass a billing or auth
      // error from one key on to the client as if the request itself were bad.
      if (last.outcome.kind === "credit" || last.outcome.kind === "auth") {
        return sendJson(res, 429, "rate_limit_error", "Accounts are being tried; retry", {
          "retry-after": "1",
        });
      }
    }
    if (last) return this.passThrough(res, last);
    if (networkFailed) return sendJson(res, 502, "api_error", "Upstream request failed");
    return this.exhausted(res);
  }

  private exhausted(res: ServerResponse): void {
    const status = this.pool.status();
    const next = status.nextAvailableAt ? Date.parse(status.nextAvailableAt) : NaN;
    const secs = Number.isFinite(next) ? Math.max(1, Math.ceil((next - this.now()) / 1000)) : 60;
    sendJson(res, 429, "rate_limit_error", status.reason ?? "No account can take requests", {
      "retry-after": String(secs),
    });
  }

  private passThrough(res: ServerResponse, b: Buffered): void {
    if (res.headersSent) return void res.end();
    const headers = this.responseHeaders(b.headers);
    headers["content-length"] = b.body.length;
    res.writeHead(b.status, headers);
    res.end(b.body);
  }

  private responseHeaders(h: IncomingHttpHeaders): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(h)) {
      if (value === undefined || RESPONSE_DROP.has(name)) continue;
      if (RESPONSE_EXACT.has(name) || name.startsWith("anthropic-")) out[name] = value;
    }
    return out;
  }

  private requestHeaders(req: IncomingMessage, body: Buffer, key: string): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (FORWARD_EXACT.has(name) || FORWARD_PREFIX.some((p) => name.startsWith(p)))
        out[name] = value;
    }
    // R1: a client must not be able to shape a request into an auth answer that pauses an account
    // (an OAuth-only beta, an odd API version). Known-shaped values only; a full allow-list of
    // beta names is deferred because Claude Code adds new ones often.
    const version = out["anthropic-version"];
    if (typeof version !== "string" || !KNOWN_VERSIONS.has(version)) {
      out["anthropic-version"] = "2023-06-01";
    }
    const beta = out["anthropic-beta"];
    if (beta !== undefined) {
      const kept = (Array.isArray(beta) ? beta.join(",") : String(beta))
        .split(",")
        .map((t) => t.trim())
        .filter((t) => /^[a-z0-9][a-z0-9.-]{0,63}$/.test(t) && !/oauth/.test(t));
      if (kept.length > 0) out["anthropic-beta"] = kept.slice(0, 32).join(",");
      else delete out["anthropic-beta"];
    }
    out["x-api-key"] = key;
    out["accept-encoding"] = "identity";
    if (req.method === "POST") out["content-length"] = body.length;
    return out;
  }

  private send(
    path: string,
    req: IncomingMessage,
    body: Buffer,
    key: string,
    track: (r: http.ClientRequest) => void,
  ): Promise<Upstream> {
    return new Promise((resolve) => {
      const lib = this.origin.protocol === "https:" ? https : http;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const done = (v: Upstream) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        resolve(v);
      };
      const out = lib.request(
        {
          agent: this.agent,
          protocol: this.origin.protocol,
          hostname: this.origin.hostname,
          port: this.origin.port || undefined,
          method: req.method,
          path,
          headers: this.requestHeaders(req, body, key),
        },
        (up) => done({ ok: true, res: up }),
      );
      track(out);
      const headersTimer = setTimeout(
        () => out.destroy(new Error("upstream header timeout")),
        this.headersMs,
      );
      headersTimer.unref();
      timers.push(headersTimer);
      out.on("socket", (socket) => {
        if (!socket.connecting) return;
        const t = setTimeout(
          () => out.destroy(new Error("upstream connect timeout")),
          this.connectMs,
        );
        t.unref();
        timers.push(t);
        socket.once("connect", () => clearTimeout(t));
      });
      out.on("error", (err) => done({ ok: false, error: err.message }));
      out.end(req.method === "POST" ? body : undefined);
    });
  }

  /** True when `GET /v1/models` with only the key and the fixed version header answers 401. */
  private keyRejected(key: string): Promise<boolean> {
    return new Promise((resolve) => {
      const lib = this.origin.protocol === "https:" ? https : http;
      const out = lib.request(
        {
          agent: this.agent,
          protocol: this.origin.protocol,
          hostname: this.origin.hostname,
          port: this.origin.port || undefined,
          method: "GET",
          path: "/v1/models",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "accept-encoding": "identity",
          },
        },
        (up) => {
          up.resume();
          resolve(up.statusCode === 401);
        },
      );
      const t = setTimeout(() => out.destroy(new Error("recheck timeout")), this.headersMs);
      t.unref();
      out.on("close", () => clearTimeout(t));
      out.on("error", () => resolve(false)); // cannot confirm: leave the account in service
      out.end();
    });
  }

  private bufferError(up: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_ERROR_BODY) chunks.push(c);
        else up.destroy();
      });
      const finish = () => resolve(Buffer.concat(chunks));
      up.on("end", finish);
      up.on("error", finish);
      up.on("close", finish);
    });
  }

  private stream(
    up: IncomingMessage,
    res: ServerResponse,
    accountId: string,
    runId: string,
    countUsage: boolean,
    started: number,
    token: string | undefined,
  ): void {
    const status = up.statusCode ?? 200;
    const tap = countUsage ? new UsageTap(up.headers["content-type"]) : undefined;
    res.writeHead(status, this.responseHeaders(up.headers));
    res.flushHeaders();
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => up.destroy(new Error("upstream idle timeout")), this.idleMs);
      idle.unref();
    };
    arm();
    let finished = false;
    let complete = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(idle);
      const usage = tap?.end();
      if (usage) this.pool.recordUsage(accountId, usage);
      this.log({
        event: "request",
        accountId,
        runId,
        status,
        durationMs: this.now() - started,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });
      // An upstream that dropped mid-stream must not look like a complete response.
      if (res.writableEnded) return;
      if (complete) res.end();
      else res.destroy();
    };
    up.on("data", (chunk: Buffer) => {
      // A token revoked or expired mid-stream ends the stream.
      if (!this.tokens.verify(token)) return void up.destroy(new Error("run token ended"));
      arm();
      tap?.write(chunk);
    });
    up.on("end", () => {
      complete = true;
      finish();
    });
    up.on("error", finish);
    up.on("aborted", finish);
    up.on("close", finish);
    up.pipe(res, { end: false });
    res.on("close", () => {
      clearTimeout(idle);
      up.destroy();
    });
  }
}
