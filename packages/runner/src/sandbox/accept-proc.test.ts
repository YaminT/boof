import { expect, it } from "vitest";
import { join } from "node:path";
import {
  closeListen,
  landlockAbi,
  linuxSandboxSuite,
  listen,
  makeFixture,
  runProbe,
  sandboxed,
  shQuote,
} from "./accept-support.js";

linuxSandboxSuite("sandbox acceptance: proc, signals and descendants", () => {
  it("A8 denies /proc/<pid>/environ and, on ABI 6+, a signal to that pid", async () => {
    const fx = await makeFixture();
    let signals = 0;
    const onSignal = () => {
      signals += 1;
    };
    process.on("SIGUSR1", onSignal);
    try {
      const env = await runProbe(fx, ["environ", String(process.pid)]);
      const signal = await runProbe(fx, ["signal", String(process.pid)]);
      expect(env.code, env.stderr).toBe(0);
      expect(env.stdout).toBe("environ EACCES\n");
      if (landlockAbi() >= 6) {
        expect(signal.stdout).toBe("signal EPERM\n");
        expect(signals).toBe(0);
      }
    } finally {
      process.off("SIGUSR1", onSignal);
    }
  }, 60_000);

  it("A13 repeats the secret read and the boof-port connect after sh, a grandchild, setsid and a double fork", async () => {
    const fx = await makeFixture();
    const held = await listen("127.0.0.1");
    fx.ctx.serverPort = held.port;
    const secret = join(fx.data, "settings.json");
    const port = String(held.port);
    const read = `${shQuote(fx.probe)} read ${shQuote(secret)}`;
    const connect = `${shQuote(fx.probe)} connect4 ${shQuote(port)}`;
    try {
      const shellRead = await sandboxed(fx, "/bin/sh", ["-c", read]);
      const shellConnect = await sandboxed(fx, "/bin/sh", ["-c", connect]);
      const grandRead = await sandboxed(fx, "/bin/sh", ["-c", `/bin/sh -c ${shQuote(read)}`]);
      const grandConnect = await sandboxed(fx, "/bin/sh", ["-c", `/bin/sh -c ${shQuote(connect)}`]);
      const sidRead = await runProbe(fx, ["setsid-read", secret]);
      const sidConnect = await runProbe(fx, ["setsid-connect4", port]);
      const doubleRead = await runProbe(fx, ["double-read", secret]);
      const doubleConnect = await runProbe(fx, ["double-connect4", port]);
      expect(shellRead.code, shellRead.stderr).toBe(0);
      expect(shellRead.stdout).toBe("read EACCES\n");
      expect(shellConnect.stdout).toBe("connect EACCES\n");
      expect(grandRead.stdout).toBe("read EACCES\n");
      expect(grandConnect.stdout).toBe("connect EACCES\n");
      expect(sidRead.stdout).toBe("read EACCES\n");
      expect(sidConnect.stdout).toBe("connect EACCES\n");
      expect(doubleRead.stdout).toBe("read EACCES\n");
      expect(doubleConnect.stdout).toBe("connect EACCES\n");
      for (const result of [shellRead, grandRead, sidRead, doubleRead]) {
        expect(result.stdout).not.toContain("secret");
      }
    } finally {
      await closeListen(held);
    }
  }, 90_000);
});
