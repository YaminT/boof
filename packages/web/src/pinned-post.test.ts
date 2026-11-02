import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinnedPost } from "./pinned-post.js";

interface Seen {
  host: string | undefined;
  method: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let port: number;
let seen: Seen[];
let answer: { status: number; headers?: Record<string, string>; delayMs?: number };

beforeEach(async () => {
  seen = [];
  answer = { status: 204 };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ host: req.headers.host, method: req.method, headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(answer.status, answer.headers);
        res.end("ignored body");
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const init = (over: Partial<Parameters<typeof pinnedPost>[2]> = {}) => ({
  headers: { "Content-Type": "application/json", "X-Boof-Event": "task.status" },
  body: '{"a":1}',
  signal: AbortSignal.timeout(5_000),
  ...over,
});

describe("pinnedPost", () => {
  // `.test` names never resolve: reaching the server proves the connection went to the pinned
  // address and the name was not looked up again.
  it("connects to the pinned address, keeps the URL's Host header, sends method, headers and body", async () => {
    const res = await pinnedPost(
      `http://never-resolves.test:${port}/in?x=1`,
      ["127.0.0.1"],
      init(),
    );
    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0].host).toBe(`never-resolves.test:${port}`);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers["x-boof-event"]).toBe("task.status");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].body).toBe('{"a":1}');
  });

  it("tries only the pinned addresses: a name with none left to try fails, it is not resolved", async () => {
    // Port 1 on loopback refuses; the name would never resolve, so DNS was not consulted.
    await expect(
      pinnedPost(`http://never-resolves.test:1/`, ["127.0.0.1"], init()),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("does not follow a redirect: it reports the 3xx", async () => {
    answer = { status: 302, headers: { Location: "http://169.254.169.254/latest" } };
    const res = await pinnedPost(`http://never-resolves.test:${port}/`, ["127.0.0.1"], init());
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it("gives up when the signal aborts", async () => {
    answer = { status: 200, delayMs: 2_000 };
    await expect(
      pinnedPost(
        `http://never-resolves.test:${port}/`,
        ["127.0.0.1"],
        init({ signal: AbortSignal.timeout(100) }),
      ),
    ).rejects.toThrow();
  });

  it("with no pinned address (an exempted host) it resolves the name normally", async () => {
    const res = await pinnedPost(`http://localhost:${port}/`, [], init());
    expect(res.status).toBe(204);
  });
});
