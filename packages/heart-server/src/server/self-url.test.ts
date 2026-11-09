import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { createSelfUrlCheck } from "./self-url.js";

const u = (s: string) => new URL(s);

describe("createSelfUrlCheck", () => {
  const check = createSelfUrlCheck({
    port: 4319,
    bindHost: "boof.lan",
    allowedHosts: ["me.example:443"],
  });

  it("matches loopback names and the bound port, with IPv4-mapped forms unwrapped", () => {
    for (const url of [
      "http://127.0.0.1:4319",
      "http://localhost:4319/x",
      "http://[::1]:4319",
      "http://0.0.0.0:4319",
      "http://[::ffff:127.0.0.1]:4319",
      "http://[::ffff:7f00:1]:4319",
      "http://boof.lan:4319",
      "http://me.example:4319",
    ]) {
      expect(check(u(url)), url).toBe(true);
    }
  });

  it("matches this machine's interface addresses on the port", () => {
    const addr = Object.values(networkInterfaces())
      .flat()
      .find((a) => a?.family === "IPv4")?.address;
    if (addr) expect(check(u(`http://${addr}:4319`))).toBe(true);
  });

  it("does not match another port or another host; the default port is used when absent", () => {
    expect(check(u("http://127.0.0.1:5678"))).toBe(false);
    expect(check(u("http://localhost"))).toBe(false);
    expect(check(u("http://n8n.example:4319"))).toBe(false);
    expect(createSelfUrlCheck({ port: 80 })(u("http://localhost"))).toBe(true);
    expect(createSelfUrlCheck({ port: 443 })(u("https://localhost"))).toBe(true);
  });

  it("reads the port lazily when given a function", () => {
    let port = 0;
    const lazy = createSelfUrlCheck({ port: () => port });
    port = 5000;
    expect(lazy(u("http://127.0.0.1:5000"))).toBe(true);
  });
});

describe("createSelfUrlCheck callbackBaseUrl", () => {
  it("counts the port of a local callback URL, not of a remote one", () => {
    const local = createSelfUrlCheck({ port: 4319, callbackBaseUrl: "http://127.0.0.1:4400/boof" });
    expect(local(u("http://localhost:4400"))).toBe(true);
    expect(local(u("http://[::ffff:127.0.0.1]:4400"))).toBe(true);
    expect(local(u("http://[::]:4400"))).toBe(true);
    expect(local(u("http://n8n.example:4400"))).toBe(false);
    const remote = createSelfUrlCheck({ port: 4319, callbackBaseUrl: "https://boof.example:9443" });
    expect(remote(u("http://127.0.0.1:9443"))).toBe(false);
  });

  it("withCallback adds the port to an existing check", () => {
    const base = createSelfUrlCheck({ port: 4319 });
    expect(base(u("http://127.0.0.1:4400"))).toBe(false);
    expect(base.withCallback("http://localhost:4400")(u("http://127.0.0.1:4400"))).toBe(true);
  });
});
