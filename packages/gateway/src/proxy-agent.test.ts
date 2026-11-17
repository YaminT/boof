import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectProxyAgent, proxyFromEnv } from "./proxy-agent.js";

const target = new URL("https://api.anthropic.com");

describe("proxyFromEnv", () => {
  it("is null without a variable", () => expect(proxyFromEnv(target, {})).toBeNull());
  it("reads HTTPS_PROXY and the lowercase form", () => {
    expect(proxyFromEnv(target, { HTTPS_PROXY: "http://p:3128" })?.host).toBe("p:3128");
    expect(proxyFromEnv(target, { https_proxy: "p:3128" })?.host).toBe("p:3128");
  });
  it("respects NO_PROXY by host, suffix and *", () => {
    const env = { HTTPS_PROXY: "http://p:3128" };
    expect(proxyFromEnv(target, { ...env, NO_PROXY: "api.anthropic.com" })).toBeNull();
    expect(proxyFromEnv(target, { ...env, NO_PROXY: ".anthropic.com" })).toBeNull();
    expect(proxyFromEnv(target, { ...env, NO_PROXY: "example.com" })).not.toBeNull();
    expect(proxyFromEnv(target, { ...env, NO_PROXY: "*" })).toBeNull();
  });
  it("ignores a garbled value", () =>
    expect(proxyFromEnv(target, { HTTPS_PROXY: "http://" })).toBeNull());
});

describe("ConnectProxyAgent", () => {
  let proxy: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r())));

  it("sends CONNECT host:port with proxy credentials, and an error never shows them", async () => {
    const seen: { url?: string; auth?: string } = {};
    proxy = http.createServer();
    proxy.on("connect", (req, socket) => {
      seen.url = req.url;
      seen.auth = req.headers["proxy-authorization"] as string;
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as AddressInfo).port;
    const agent = new ConnectProxyAgent(new URL(`http://user:s3cret@127.0.0.1:${port}`));
    const err = await new Promise<Error>((resolve) => {
      const req = https.request({ agent, hostname: "api.anthropic.com", path: "/" });
      req.on("error", resolve);
      req.end();
    });
    agent.destroy();
    expect(seen.url).toBe("api.anthropic.com:443");
    expect(seen.auth).toBe(`Basic ${Buffer.from("user:s3cret").toString("base64")}`);
    expect(err.message).toContain("502");
    expect(err.message).not.toContain("s3cret");
  });

  it("refuses an https:// proxy", () => {
    expect(() => new ConnectProxyAgent(new URL("https://p:1"))).toThrow();
  });
});
