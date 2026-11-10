import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";

export interface PinnedPostInit {
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface PinnedRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** Read at most this many response bytes (0, the default: drop the body). Over it: reject "response too large". */
  maxResponseBytes?: number;
}

/** A rejection of `pinnedRequest`: `bodySent` is true when the request had been fully written. */
function fail(err: unknown, bodySent: boolean): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { bodySent });
}

/**
 * Send one request to `url`, connecting only to `addresses` (the ones the SSRF guard checked) instead
 * of resolving the name again: a DNS answer that changes between the check and the connection
 * (rebinding) cannot send the request somewhere else. The URL's host stays the `Host` header and
 * the TLS server name and certificate name. No redirect is followed: a 3xx is returned as it is.
 * The response body is dropped, or read up to `maxResponseBytes`. With no address (a host exempted
 * from the check) the name is resolved normally. Each call opens its own connection (`agent:
 * false`), so a socket pooled for one address is never reused for another. A rejection carries
 * `bodySent: boolean`: whether the request was fully written before the failure.
 */
export function pinnedRequest(
  url: string,
  addresses: readonly string[],
  init: PinnedRequestInit,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const cap = init.maxResponseBytes ?? 0;
  const lookup: net.LookupFunction | undefined =
    addresses.length === 0
      ? undefined
      : (_host, options, callback) => {
          const entries = addresses.map((address) => ({ address, family: net.isIP(address) }));
          if (options.all)
            (callback as unknown as (e: null, a: typeof entries) => void)(null, entries);
          else callback(null, entries[0].address, entries[0].family);
        };
  const headers: Record<string, string | number> = { ...init.headers };
  if (init.body !== undefined) headers["Content-Length"] = Buffer.byteLength(init.body);
  return new Promise((resolve, reject) => {
    let bodySent = false;
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: init.method,
        headers,
        agent: false,
        lookup,
        signal: init.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (cap <= 0) {
          res.destroy();
          resolve({ status, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > cap) {
            reject(fail(new Error("response too large"), bodySent));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => reject(fail(err, bodySent)));
        res.on("aborted", () => reject(fail(new Error("response aborted"), bodySent)));
      },
    );
    req.on("finish", () => {
      bodySent = true;
    });
    req.on("error", (err) => reject(fail(err, bodySent)));
    req.end(init.body);
  });
}

/** POST `body` to `url` (see `pinnedRequest`); the response body is dropped, the result is the status. */
export async function pinnedPost(
  url: string,
  addresses: readonly string[],
  init: PinnedPostInit,
): Promise<{ status: number }> {
  const { status } = await pinnedRequest(url, addresses, { ...init, method: "POST" });
  return { status };
}
