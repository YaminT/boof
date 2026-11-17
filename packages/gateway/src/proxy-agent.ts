import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";

/**
 * Upstream calls honour HTTPS_PROXY / NO_PROXY (decision D7). Only the upstream origin is ever
 * reached this way; the proxy URL (which may hold credentials) is never logged or put in an error.
 */

type Env = Record<string, string | undefined>;

/** The proxy for `target` from the environment, or null (none set, or NO_PROXY matches). */
export function proxyFromEnv(target: URL, env: Env = process.env): URL | null {
  const secure = target.protocol === "https:";
  const raw = secure
    ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy);
  if (!raw) return null;
  if (bypassed(target, env.NO_PROXY ?? env.no_proxy ?? "")) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

function bypassed(target: URL, noProxy: string): boolean {
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (const entry of noProxy.split(/[,\s]+/)) {
    if (!entry) continue;
    if (entry === "*") return true;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry.toLowerCase());
    let name = m?.[1] ?? entry.toLowerCase();
    if (m?.[2] && m[2] !== port) continue;
    name = name.replace(/^\*?\./, "");
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/** An https agent that reaches the origin through an HTTP proxy with CONNECT. */
export class ConnectProxyAgent extends https.Agent {
  constructor(
    private readonly proxy: URL,
    options: https.AgentOptions = {},
    private readonly connectTimeoutMs = 10_000,
  ) {
    super(options);
    if (proxy.protocol !== "http:") throw new Error("only http:// proxies are supported");
  }

  // Node's agent calls this with a callback when the socket is not returned synchronously.
  override createConnection(
    options: tls.ConnectionOptions & { host?: string; port?: number | string },
    callback?: (err: Error | null, socket: Duplex) => void,
  ): Duplex {
    const cb = (err: Error | null, socket?: Duplex) => callback?.(err, socket as Duplex);
    const host = options.host ?? "";
    const port = options.port ?? 443;
    const headers: http.OutgoingHttpHeaders = { host: `${host}:${port}` };
    if (this.proxy.username || this.proxy.password) {
      const cred = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
    }
    const req = http.request({
      host: this.proxy.hostname.replace(/^\[|\]$/g, ""),
      port: this.proxy.port || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: this.connectTimeoutMs,
    });
    req.once("timeout", () => req.destroy(new Error("proxy connect timeout")));
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error(`proxy refused the tunnel (HTTP ${res.statusCode})`));
        return;
      }
      const secure = tls.connect({
        ...options,
        socket,
        servername: options.servername ?? host,
      } as tls.ConnectionOptions);
      cb(null, secure);
    });
    req.once("error", (err: NodeJS.ErrnoException) =>
      cb(new Error(`proxy connection failed: ${err.code ?? "error"}`)),
    );
    req.end();
    return undefined as unknown as Duplex;
  }
}
