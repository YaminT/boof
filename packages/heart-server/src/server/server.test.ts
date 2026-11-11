import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataRootPaths, defaultSettings, SettingsStore } from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { startServer, type RunningServer } from "./server.js";

const PRUNE_MS = 3600_000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-server-"));
  await new SettingsStore(root).save(defaultSettings());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The hourly prune timers created since `from` (the index into the setInterval spy's results). */
function pruneTimersSince(
  spy: { mock: { calls: unknown[][]; results: { value: unknown }[] } },
  from: number,
) {
  return spy.mock.calls
    .slice(from)
    .map((args, i) => (args[1] === PRUNE_MS ? spy.mock.results[from + i]!.value : undefined))
    .filter((t) => t !== undefined);
}

const start = (port: number): Promise<RunningServer> =>
  startServer({
    catalog: new ToolRegistry([new MockTool()]),
    root,
    port,
    warn: () => {},
  });

describe("startServer's external-step prune timer", () => {
  it("records its live port and reserves IPv6 when that address is available", async () => {
    const srv = await start(0);
    try {
      const record = JSON.parse(await readFile(dataRootPaths(root).serverPort, "utf8")) as {
        pid: number;
        port: number;
      };
      expect(record).toEqual({ pid: process.pid, port: srv.port });
      for (const host of ["127.0.0.1", "::1"]) {
        try {
          await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host, port: srv.port });
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
          });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (host === "127.0.0.1" || !["EAFNOSUPPORT", "EADDRNOTAVAIL", "EADDRINUSE"].includes(code ?? "")) {
            throw err;
          }
        }
      }
      await srv.stop();
      await expect(readFile(dataRootPaths(root).serverPort, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (srv.server.listening) await srv.stop();
    }
  });

  it("keeps the IPv4 server running when the optional IPv6 reservation is busy", async () => {
    const portPicker = createNetServer();
    await new Promise<void>((resolve) => portPicker.listen(0, "127.0.0.1", resolve));
    const address = portPicker.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    await new Promise<void>((resolve) => portPicker.close(() => resolve()));

    const holder6 = createNetServer();
    await new Promise<void>((resolve, reject) => {
      holder6.once("error", reject);
      holder6.listen({ host: "::1", port: address.port, ipv6Only: true }, resolve);
    });
    let srv: RunningServer | undefined;
    try {
      srv = await start(address.port);
      await expect(new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: srv!.port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      })).resolves.toBeUndefined();
    } finally {
      if (srv?.server.listening) await srv.stop();
      await new Promise<void>((resolve) => holder6.close(() => resolve()));
    }
  });

  it("stop() clears the hourly prune interval", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const from = setSpy.mock.calls.length;
    const srv = await start(0);
    const timers = pruneTimersSince(setSpy, from);
    expect(timers).toHaveLength(1);
    expect(clearSpy).not.toHaveBeenCalledWith(timers[0]);
    await srv.stop();
    expect(clearSpy).toHaveBeenCalledWith(timers[0]);
  });

  it("clears the prune interval when the server fails to listen", async () => {
    const holder = createNetServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    try {
      const setSpy = vi.spyOn(globalThis, "setInterval");
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      const from = setSpy.mock.calls.length;
      await expect(start(address.port)).rejects.toThrow();
      const timers = pruneTimersSince(setSpy, from);
      expect(timers).toHaveLength(1);
      expect(clearSpy).toHaveBeenCalledWith(timers[0]);

      const retry = await start(0);
      await retry.stop();
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
