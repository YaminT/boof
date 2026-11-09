// A fake n8n for tests: the public API (`GET /api/v1/workflows`) and production webhooks
// (`POST /webhook/<path>`). Listens on 127.0.0.1, port 0. Never contacts anything.
import { createServer, type IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";

export interface FakeN8nCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeWorkflow(o: {
  id: string;
  name: string;
  active?: boolean;
  updatedAt?: string;
  webhook?: { path: string; method?: string } | null;
}): unknown {
  return {
    id: o.id,
    name: o.name,
    active: o.active ?? true,
    updatedAt: o.updatedAt ?? "2026-11-09T10:00:00.000Z",
    tags: [],
    nodes: o.webhook
      ? [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: { path: o.webhook.path, httpMethod: o.webhook.method ?? "POST" },
          },
        ]
      : [{ name: "Manual", type: "n8n-nodes-base.manualTrigger", parameters: {} }],
  };
}

function flatten(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = String(v);
  return out;
}

export async function startFakeN8n(opts: {
  apiKey: string;
  workflows?: unknown[];
  pageSize?: number;
  /** Webhook answer; default 200. May call back into boof itself. */
  onWebhook?: (
    call: FakeN8nCall,
  ) => Promise<{ status: number; delayMs?: number }> | { status: number; delayMs?: number };
}): Promise<{ url: string; calls: FakeN8nCall[]; close(): Promise<void> }> {
  const calls: FakeN8nCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text === "" ? undefined : text;
        try {
          if (text) body = JSON.parse(text);
        } catch {
          // keep the text
        }
        const call: FakeN8nCall = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: flatten(req.headers),
          body,
        };
        calls.push(call);
        const url = new URL(call.path, "http://fake.invalid");
        if (url.pathname === "/api/v1/workflows" && call.method === "GET") {
          if (call.headers["x-n8n-api-key"] !== opts.apiKey) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "unauthorized" }));
            return;
          }
          const all = opts.workflows ?? [];
          const size = opts.pageSize ?? 100;
          const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
          const data = all.slice(start, start + size);
          const next = start + size < all.length ? String(start + size) : null;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data, nextCursor: next }));
          return;
        }
        if (url.pathname.startsWith("/webhook/") && call.method === "POST") {
          const answer = (await opts.onWebhook?.(call)) ?? { status: 200 };
          if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(answer.status);
            res.end(JSON.stringify({ message: "Workflow was started" }));
          }
          return;
        }
        res.writeHead(404);
        res.end("{}");
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * A self check built like the one in `server/server.ts`: the names boof answers to (localhost,
 * its bind host, wildcard spellings, interface addresses) on boof's bound port.
 */
export function serverSelfCheck(
  boundPort: number,
  bindHost = "127.0.0.1",
  extraNames: string[] = [],
): (url: URL) => boolean {
  const names = new Set(
    ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", bindHost.toLowerCase(), ...extraNames].map(
      (h) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h),
    ),
  );
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) names.add(a.family === "IPv6" ? `[${a.address}]` : a.address);
  }
  return (url) =>
    Number(url.port || (url.protocol === "https:" ? 443 : 80)) === boundPort &&
    names.has(url.hostname.toLowerCase());
}

/** A self check for tests where boof is nowhere near: a port nothing uses. */
export const notSelf = serverSelfCheck(1);
