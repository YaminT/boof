import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackAddress,
  loopbackListenerUids,
  n8nLoopbackRefusal,
  n8nSendRefusal,
  openLoopbackRefusal,
  type ListenerLookupDeps,
} from "./loopback-listener.js";

const TCP4_HEAD =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const TCP6_HEAD =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

/** One LISTEN row. `ip` is the proc hex (LE), 8 chars for v4 and 32 for v6. */
function row(ip: string, port: number, uid: number, state = "0A"): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const zeros = "0".repeat(ip.length);
  return `   0: ${ip}:${portHex} ${zeros}:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 12345 1 0000000000000000 100 0 0 10 0\n`;
}

const V4_LOOP = "0100007F"; // 127.0.0.1
const V4_WILD = "00000000"; // 0.0.0.0
const V4_OTHER = "0200007F"; // 127.0.0.2
const V6_LOOP = "00000000000000000000000001000000"; // ::1
const V6_WILD = "00000000000000000000000000000000"; // ::
const V6_MAPPED = "0000000000000000FFFF00000100007F"; // ::ffff:127.0.0.1

function tables(tcp: string, tcp6 = ""): ListenerLookupDeps["readFile"] {
  return (path) => {
    if (path === "/proc/net/tcp") return TCP4_HEAD + tcp;
    if (path === "/proc/net/tcp6") return TCP6_HEAD + tcp6;
    return null;
  };
}

const linux = (readFile: ListenerLookupDeps["readFile"], uid = 1000): ListenerLookupDeps => ({
  platform: "linux",
  endian: "LE",
  uid,
  readFile,
});

describe("loopback listener owners", () => {
  it("knows loopback addresses, including the IPv4-mapped form", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("93.184.216.34")).toBe(false);
  });

  it("reads the uid column and prefers an exact bind over a wildcard", () => {
    const deps = linux(tables(row(V4_LOOP, 4319, 1000) + row(V4_WILD, 4319, 1001)));
    expect(loopbackListenerUids("127.0.0.1", 4319, deps)).toEqual({ kind: "uids", uids: [1000] });
    expect(loopbackListenerUids("127.0.0.2", 4319, linux(tables(row(V4_OTHER, 4319, 7))))).toEqual({
      kind: "uids",
      uids: [7],
    });
  });

  it("a v4 wildcard or a v6 wildcard covers 127.0.0.1 when nothing is bound to it", () => {
    expect(loopbackListenerUids("127.0.0.1", 5678, linux(tables(row(V4_WILD, 5678, 0))))).toEqual({
      kind: "uids",
      uids: [0],
    });
    expect(
      loopbackListenerUids("127.0.0.1", 5678, linux(tables("", row(V6_WILD, 5678, 0)))),
    ).toEqual({ kind: "uids", uids: [0] });
  });

  it("an IPv4-mapped listener is the exact owner of 127.0.0.1", () => {
    const deps = linux(tables("", row(V6_MAPPED, 5678, 1000) + row(V6_WILD, 5678, 1001)));
    expect(loopbackListenerUids("127.0.0.1", 5678, deps)).toEqual({ kind: "uids", uids: [1000] });
    expect(loopbackListenerUids("::ffff:127.0.0.1", 5678, deps)).toEqual({
      kind: "uids",
      uids: [1000],
    });
  });

  it("::1 matches the v6 loopback row and not a v4 listener", () => {
    const deps = linux(tables(row(V4_LOOP, 4319, 1000), row(V6_LOOP, 4319, 1005)));
    expect(loopbackListenerUids("::1", 4319, deps)).toEqual({ kind: "uids", uids: [1005] });
    expect(loopbackListenerUids("[::1]", 4319, deps)).toEqual({ kind: "uids", uids: [1005] });
  });

  it("ignores sockets that are not listening, and an empty table is none", () => {
    const established = row(V4_LOOP, 4319, 1001, "01");
    expect(loopbackListenerUids("127.0.0.1", 4319, linux(tables(established)))).toEqual({
      kind: "none",
    });
    expect(loopbackListenerUids("127.0.0.1", 4319, linux(tables("")))).toEqual({ kind: "none" });
  });

  it("a missing proc table is unreadable; other platforms do not read it", () => {
    expect(
      loopbackListenerUids(
        "127.0.0.1",
        1,
        linux(() => null),
      ),
    ).toEqual({
      kind: "unreadable",
    });
    const readFile = (): string => {
      throw new Error("proc");
    };
    expect(loopbackListenerUids("127.0.0.1", 1, { platform: "darwin", readFile })).toEqual({
      kind: "skip",
    });
    expect(loopbackListenerUids("127.0.0.1", 1, { platform: "win32", readFile })).toEqual({
      kind: "skip",
    });
  });

  it("big-endian address words are not swapped", () => {
    const deps: ListenerLookupDeps = {
      platform: "linux",
      endian: "BE",
      readFile: tables(row("7F000001", 80, 4)),
    };
    expect(loopbackListenerUids("127.0.0.1", 80, deps)).toEqual({ kind: "uids", uids: [4] });
  });
});

describe("openLoopbackRefusal", () => {
  it("refuses another uid, including root, and says so in one line", () => {
    const held = linux(tables(row(V4_LOOP, 4319, 1001)));
    expect(openLoopbackRefusal("127.0.0.1", 4319, held)).toBe(
      "port 4319 is held by uid 1001, not by your boof",
    );
    expect(openLoopbackRefusal("127.0.0.1", 4319, linux(tables(row(V4_WILD, 4319, 0))))).toBe(
      "port 4319 is held by uid 0, not by your boof",
    );
  });

  it("allows this user only when every address has a listener, and skips the check off Linux", () => {
    expect(openLoopbackRefusal("127.0.0.1", 4319, linux(tables(row(V4_LOOP, 4319, 1000))))).toBe(
      null,
    );
    expect(openLoopbackRefusal("127.0.0.1", 4319, linux(tables("")))).toBe(
      "nothing owned by you on 127.0.0.1:4319; start boof first",
    );
    const half = linux(tables(row(V4_LOOP, 4319, 1000)));
    expect(openLoopbackRefusal("::1", 4319, half)).toBe(
      "nothing owned by you on [::1]:4319; use --host 127.0.0.1",
    );
    expect(openLoopbackRefusal("localhost", 4319, half)).toBe(
      "nothing owned by you on [::1]:4319; use --host 127.0.0.1",
    );
    expect(
      openLoopbackRefusal("127.0.0.1", 4319, linux(tables("", row(V6_LOOP, 4319, 1000)))),
    ).toBe("nothing owned by you on 127.0.0.1:4319; use --host ::1");
    expect(
      openLoopbackRefusal(
        "localhost",
        4319,
        linux(tables(row(V4_LOOP, 4319, 1000), row(V6_LOOP, 4319, 1000))),
      ),
    ).toBeNull();
    const readFile = (): string => {
      throw new Error("proc");
    };
    expect(openLoopbackRefusal("127.0.0.1", 4319, { platform: "darwin", readFile })).toBeNull();
  });

  it("a foreign uid wins over an address where nothing is listening", () => {
    const mixed = linux(tables(row(V4_LOOP, 4319, 1001)));
    expect(openLoopbackRefusal("localhost", 4319, mixed)).toBe(
      "port 4319 is held by uid 1001, not by your boof",
    );
  });

  it("localhost is refused when either address is held by someone else", () => {
    const deps = linux(tables(row(V4_LOOP, 4319, 1000), row(V6_LOOP, 4319, 1001)));
    expect(openLoopbackRefusal("localhost", 4319, deps)).toBe(
      "port 4319 is held by uid 1001, not by your boof",
    );
    expect(openLoopbackRefusal("::1", 4319, deps)).toBe(
      "port 4319 is held by uid 1001, not by your boof",
    );
  });

  it("refuses when the tables cannot be read", () => {
    expect(
      openLoopbackRefusal(
        "127.0.0.1",
        4319,
        linux(() => null),
      ),
    ).toBe("cannot see who is listening on port 4319; not printing a sign-in link");
  });
});

describe("n8nLoopbackRefusal", () => {
  it("refuses another uid and a port with no listener, and allows this user or root", () => {
    expect(n8nLoopbackRefusal("127.0.0.1", 5678, linux(tables(row(V4_LOOP, 5678, 1001))))).toEqual({
      reason: "listener_not_owner: port 5678 on 127.0.0.1 is held by uid 1001, not by uid 1000",
      retryable: false,
    });
    expect(n8nLoopbackRefusal("127.0.0.1", 5678, linux(tables("")))).toEqual({
      reason: "listener_not_owner: nothing owned by uid 1000 is listening on 127.0.0.1:5678",
      retryable: true,
    });
    expect(n8nLoopbackRefusal("127.0.0.1", 5678, linux(tables(row(V4_LOOP, 5678, 1000))))).toBe(
      null,
    );
    expect(n8nLoopbackRefusal("127.0.0.1", 5678, linux(tables(row(V4_WILD, 5678, 0))))).toBeNull();
  });

  it("does not look at proc for a public address or off Linux", () => {
    const readFile = (): string => {
      throw new Error("proc");
    };
    expect(n8nLoopbackRefusal("93.184.216.34", 5678, linux(readFile))).toBeNull();
    expect(n8nLoopbackRefusal("127.0.0.1", 5678, { platform: "win32", readFile })).toBeNull();
    expect(n8nLoopbackRefusal("::1", 5678, { platform: "darwin", readFile })).toBeNull();
  });

  it("refuses when the tables cannot be read", () => {
    expect(
      n8nLoopbackRefusal(
        "::1",
        5678,
        linux(() => null),
      ),
    ).toEqual({
      reason: "listener_not_owner: cannot see who is listening on ::1:5678",
      retryable: false,
    });
  });
});

const V4_DOCKER = "010011AC"; // 172.17.0.1

describe("n8nSendRefusal", () => {
  it("refuses a foreign uid and a port with nobody listening, before any send", async () => {
    const foreign = await n8nSendRefusal(
      new URL("http://127.0.0.1:5678/api/v1/workflows"),
      ["127.0.0.1"],
      linux(tables(row(V4_LOOP, 5678, 1001))),
    );
    expect(foreign).toMatchObject({ ok: false, retryable: false });
    if (foreign.ok) return;
    expect(foreign.reason).toMatch(/listener_not_owner/);
    expect(foreign.reason).toContain("uid 1001");
    await expect(
      n8nSendRefusal(new URL("http://127.0.0.1:5678/webhook/x"), ["127.0.0.1"], linux(tables(""))),
    ).resolves.toMatchObject({ ok: false, retryable: true });
  });

  it("allows this user or root, judges localhost on the resolved address, and skips off Linux", async () => {
    const owned = linux(tables(row(V4_LOOP, 5678, 1000)));
    expect(await n8nSendRefusal(new URL("http://127.0.0.1:5678/"), ["127.0.0.1"], owned)).toEqual({
      ok: true,
      addresses: ["127.0.0.1"],
    });
    expect(
      await n8nSendRefusal(new URL("http://localhost:5678/api"), ["127.0.0.1"], owned),
    ).toEqual({
      ok: true,
      addresses: ["127.0.0.1"],
    });
    expect(
      await n8nSendRefusal(
        new URL("http://127.0.0.1:5678/"),
        ["127.0.0.1"],
        linux(tables(row(V4_WILD, 5678, 0))),
      ),
    ).toEqual({ ok: true, addresses: ["127.0.0.1"] });
    const readFile = (): string => {
      throw new Error("proc");
    };
    expect(
      await n8nSendRefusal(new URL("http://127.0.0.1:5678/"), ["127.0.0.1"], {
        platform: "darwin",
        readFile,
      }),
    ).toEqual({ ok: true, addresses: ["127.0.0.1"] });
    expect(
      await n8nSendRefusal(new URL("http://93.184.216.34/hook"), ["93.184.216.34"], {
        ...linux(readFile),
        localAddresses: [],
      }),
    ).toEqual({ ok: true, addresses: ["93.184.216.34"] });
  });

  it("a foreign listener wins over an address where nothing is listening", async () => {
    const deps = linux(tables(row(V4_LOOP, 5678, 1001)));
    await expect(
      n8nSendRefusal(new URL("http://localhost:5678/"), ["127.0.0.1", "::1"], deps),
    ).resolves.toMatchObject({ ok: false, retryable: false });
  });

  it("resolves an empty address list for a hostname and pins what it checked", async () => {
    const owned = linux(tables(row(V4_LOOP, 5678, 1000)));
    expect(
      await n8nSendRefusal(new URL("http://localhost:5678/"), [], {
        ...owned,
        resolveHost: async () => ["127.0.0.1"],
      }),
    ).toEqual({ ok: true, addresses: ["127.0.0.1"] });
    const foreign = await n8nSendRefusal(new URL("http://n8n.lan:5678/hook"), [], {
      ...linux(tables(row(V4_LOOP, 5678, 1001))),
      resolveHost: async () => ["127.0.0.1"],
      localAddresses: [],
    });
    expect(foreign).toMatchObject({ ok: false, retryable: false });
    await expect(
      n8nSendRefusal(new URL("http://n8n.lan:5678/hook"), [], {
        ...linux(tables("")),
        resolveHost: async () => [],
        localAddresses: [],
      }),
    ).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reason: expect.stringContaining("does not resolve"),
    });
  });

  it("checks a non-loopback address of this host and leaves a remote one alone", async () => {
    const here = { localAddresses: ["172.17.0.1"] };
    const foreign = await n8nSendRefusal(new URL("http://172.17.0.1:5678/"), ["172.17.0.1"], {
      ...linux(tables(row(V4_WILD, 5678, 1001))),
      ...here,
    });
    expect(foreign).toMatchObject({ ok: false, retryable: false });
    if (!foreign.ok) expect(foreign.reason).toContain("uid 1001");
    expect(
      await n8nSendRefusal(new URL("http://172.17.0.1:5678/"), ["172.17.0.1"], {
        ...linux(tables(row(V4_DOCKER, 5678, 0))),
        ...here,
      }),
    ).toEqual({ ok: true, addresses: ["172.17.0.1"] });
    expect(
      await n8nSendRefusal(new URL("http://172.17.0.1:5678/"), ["172.17.0.1"], {
        ...linux(tables(row(V4_WILD, 5678, 1001))),
        localAddresses: [],
      }),
    ).toEqual({ ok: true, addresses: ["172.17.0.1"] });
  });

  it("pins only the address that had an allowed listener", async () => {
    const deps = linux(tables(row(V4_LOOP, 5678, 1000)));
    expect(
      await n8nSendRefusal(new URL("http://localhost:5678/"), ["::1", "127.0.0.1"], deps),
    ).toEqual({ ok: true, addresses: ["127.0.0.1"] });
  });
});

describe("real /proc on Linux", () => {
  const servers: Server[] = [];
  afterEach(() =>
    Promise.all(
      servers.splice(0).map((server) => new Promise<void>((r) => server.close(() => r()))),
    ),
  );

  const listen = (host: string) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer();
      servers.push(server);
      server.once("error", reject);
      server.listen(0, host, () => resolve(server));
    });

  it.skipIf(process.platform !== "linux")(
    "reports this process as the owner of its own listener",
    async () => {
      const server = await listen("127.0.0.1");
      const port = (server.address() as AddressInfo).port;
      const uid = process.getuid();
      expect(loopbackListenerUids("127.0.0.1", port)).toEqual({ kind: "uids", uids: [uid] });
      expect(openLoopbackRefusal("127.0.0.1", port)).toBeNull();
      expect(n8nLoopbackRefusal("127.0.0.1", port)).toBeNull();
    },
  );

  it.skipIf(process.platform !== "linux")("reports a ::1 listener from tcp6", async () => {
    let server: Server;
    try {
      server = await listen("::1");
    } catch {
      return;
    }
    const port = (server.address() as AddressInfo).port;
    expect(loopbackListenerUids("::1", port)).toEqual({
      kind: "uids",
      uids: [process.getuid()],
    });
  });
});
