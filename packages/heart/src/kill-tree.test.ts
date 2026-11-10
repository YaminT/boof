import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Windows reaper runs with its REAL default command runner here: only the process layer
// (`execFileSync`) is stubbed, so a default that does nothing cannot hide again.
const calls: { cmd: string; args: string[]; input?: string }[] = [];
let stopped = false;
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: (cmd: string, args: string[], opts: { input?: string } = {}) => {
      calls.push({ cmd, args, input: opts.input });
      const text = args.join(" ");
      if (text.includes("LastBootUpTime")) return "2024-11-01T08:00:00.0000000Z";
      if (text.includes("-Filter")) return stopped ? "" : "2026-11-02T17:30:07.1234560Z|1";
      if (opts.input !== undefined) {
        stopped = true;
        return "";
      }
      if (cmd === "powershell")
        return "4242|1|2026-11-02T17:30:07.1234560Z\n5000|4242|2026-11-02T17:30:09.0000000Z";
      throw new Error(`unexpected ${cmd}`);
    },
  };
});

const { reapOrphan } = await import("./pid-file.js");
const { ticksOf } = await import("./process-identity.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-killtree-"));
  calls.length = 0;
  stopped = false;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Windows reaping with the real default runner", () => {
  it("actually runs the kill script (a no-op default would leave the agent alive)", async () => {
    const path = join(dir, "pid");
    await writeFile(
      path,
      JSON.stringify({
        pgid: 4242,
        command: "claude",
        startedAt: "2026-11-02T17:30:07.000Z",
        bootId: `boottime:${Math.floor(Date.parse("2024-11-01T08:00:00Z") / 1000)}`,
        startTicks: null,
        startTime: "2026-11-02T17:30:07.1234560Z",
        ownerPid: null,
      }),
    );
    const res = await reapOrphan(path, () => {}, {
      identity: { platform: "win32" },
      // Once the kill script has run, the process is gone. An empty probe of a pid that is still
      // alive is "unknown", which must not be reported as killed.
      isAlive: () => !stopped,
    });
    expect(res.outcome).toBe("killed");
    const kill = calls.find((c) => c.input !== undefined);
    expect(kill?.cmd).toBe("powershell");
    expect(JSON.parse(kill!.input!)).toEqual([
      { pid: 5000, ticks: ticksOf("2026-11-02T17:30:09.0000000Z") },
      { pid: 4242, ticks: ticksOf("2026-11-02T17:30:07.1234560Z") },
    ]);
    expect(calls.some((c) => c.cmd === "taskkill")).toBe(false);
  });
});
