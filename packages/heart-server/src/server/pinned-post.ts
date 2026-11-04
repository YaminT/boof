import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";

export interface PinnedPostInit {
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/**
 * POST `body` to `url`, connecting only to `addresses` (the ones the SSRF guard checked) instead
 * of resolving the name again: a DNS answer that changes between the check and the connection
 * (rebinding) cannot send the request somewhere else. The URL's host stays the `Host` header and
 * the TLS server name and certificate name. No redirect is followed and the response body is
 * dropped; the result is the status. With no address (a host exempted from the check) the name
 * is resolved normally. Each call opens its own connection (`agent: false`), so a socket pooled
 * for one address is never reused for another.
 */
export function pinnedPost(
  url: string,
  addresses: readonly string[],
  init: PinnedPostInit,
): Promise<{ status: number }> {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup: net.LookupFunction | undefined =
    addresses.length === 0
      ? undefined
      : (_host, options, callback) => {
          const entries = addresses.map((address) => ({ address, family: net.isIP(address) }));
          if (options.all)
            (callback as unknown as (e: null, a: typeof entries) => void)(null, entries);
          else callback(null, entries[0].address, entries[0].family);
        };
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: "POST",
        headers: { ...init.headers, "Content-Length": Buffer.byteLength(init.body) },
        agent: false,
        lookup,
        signal: init.signal,
      },
      (res) => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
