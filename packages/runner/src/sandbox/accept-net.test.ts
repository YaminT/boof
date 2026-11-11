import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  closeListen,
  darwin,
  listen,
  makeFixture,
  runProbe,
  sandboxErrno,
  sandboxSuite,
} from "./accept-support.js";

sandboxSuite("sandbox acceptance: TCP ports and unix sockets", () => {
  it("A3 denies connect to the boof port on 127.0.0.1 and ::1", async () => {
    const fx = await makeFixture();
    const v4 = await listen("127.0.0.1");
    const v6 = await listen("::1", v4.port);
    fx.ctx.serverPort = v4.port;
    let hits = 0;
    const onConnection = () => {
      hits += 1;
    };
    v4.server.on("connection", onConnection);
    v6.server.on("connection", onConnection);
    try {
      const four = await runProbe(fx, ["connect4", String(v4.port)]);
      const six = await runProbe(fx, ["connect6", String(v4.port)]);
      expect(four.code, four.stderr).toBe(0);
      expect(four.stdout).toBe(`connect ${sandboxErrno()}\n`);
      expect(six.stdout).toBe(`connect ${sandboxErrno()}\n`);
      expect(hits).toBe(0);
    } finally {
      await closeListen(v4);
      await closeListen(v6);
    }
  }, 60_000);

  it("A4 denies binding the boof port after the listener closed", async () => {
    const fx = await makeFixture();
    const held = await listen("127.0.0.1");
    const port = held.port;
    await closeListen(held);
    fx.ctx.serverPort = port;
    const bound = await runProbe(fx, ["bind4", String(port)]);
    const bound6 = await runProbe(fx, ["bind6", String(port)]);
    expect(bound.code, bound.stderr).toBe(0);
    expect(bound.stdout).toBe(`bind ${sandboxErrno()}\n`);
    expect(bound6.stdout).toBe(`bind ${sandboxErrno()}\n`);
  }, 60_000);

  it("A5 connects to another loopback port and reads the reply", async () => {
    const fx = await makeFixture();
    const boof = await listen("127.0.0.1");
    const gateway = await listen("127.0.0.1");
    expect(gateway.port).not.toBe(boof.port);
    fx.ctx.serverPort = boof.port;
    let hits = 0;
    const peers: Socket[] = [];
    gateway.server.on("connection", (socket) => {
      hits += 1;
      peers.push(socket);
      socket.end("pong\n");
    });
    try {
      const result = await runProbe(fx, ["exchange4", String(gateway.port)]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("exchange ok pong\n");
      expect(hits).toBe(1);
    } finally {
      for (const socket of peers) socket.destroy();
      await closeListen(boof);
      await closeListen(gateway);
    }
  }, 60_000);

  it("A7 denies a pathname unix socket and an abstract one", async () => {
    const fx = await makeFixture();
    const dir = await mkdtemp(join(tmpdir(), "boof-i1f-sock-"));
    const sockPath = join(dir, "app.sock");
    const name = `boof-i1f-${process.pid}`;
    const pathServer = createServer();
    const abstractServer = createServer();
    let accepted = 0;
    const onConnection = () => {
      accepted += 1;
    };
    pathServer.on("connection", onConnection);
    abstractServer.on("connection", onConnection);
    try {
      await new Promise<void>((resolve, reject) => {
        pathServer.once("error", reject);
        pathServer.listen(sockPath, () => resolve());
      });
      // macOS has no abstract namespace. The probe's connect is still denied, and there is
      // no listener that a successful connect could reach.
      if (!darwin) {
        await new Promise<void>((resolve, reject) => {
          abstractServer.once("error", reject);
          abstractServer.listen(`\0${name}`, () => resolve());
        });
      }
      const pathResult = await runProbe(fx, ["unix", sockPath]);
      const abstractResult = await runProbe(fx, ["abstract", name]);
      expect(pathResult.code, pathResult.stderr).toBe(0);
      expect(pathResult.stdout).toBe("unix EPERM\n");
      if (darwin) {
        // macOS has no abstract namespace, so the kernel rejects the address
        // before a connect can succeed. Seatbelt may also return EPERM.
        expect(abstractResult.stdout).toMatch(/^abstract (?!ok\b)\S+\n$/);
      } else {
        expect(abstractResult.stdout).toBe("abstract EPERM\n");
      }
      expect(accepted).toBe(0);
    } finally {
      pathServer.close();
      abstractServer.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
