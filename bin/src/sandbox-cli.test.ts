import { describe, expect, it, vi } from "vitest";
import type { SandboxCheckReport } from "@boof/runner";
import { formatSandboxCheck, sandboxCommand } from "./sandbox-cli.js";

const probes = [
  ["data-root-read", "denied"],
  ["denied-port", "denied"],
  ["unix-socket", "denied"],
  ["write-outside", "denied"],
  ["signal", "denied"],
  ["write-inside", "allowed"],
] as const;

const passing: SandboxCheckReport = {
  ok: true,
  backend: "linux",
  abi: 6,
  reason: "",
  probes: probes.map(([id, outcome]) => ({ id, outcome })),
};

function capture(
  run: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const log = vi.spyOn(console, "log").mockImplementation((line) => {
    stdout += `${line}\n`;
  });
  const error = vi.spyOn(console, "error").mockImplementation((line) => {
    stderr += `${line}\n`;
  });
  return run().then((code) => {
    out.mockRestore();
    err.mockRestore();
    log.mockRestore();
    error.mockRestore();
    return { code, stdout, stderr };
  });
}

describe("formatSandboxCheck", () => {
  it("prints backend, ABI and each probe", () => {
    const text = formatSandboxCheck(passing);
    expect(text.stdout).toBe(
      [
        "backend: linux",
        "abi: 6",
        "data-root-read: denied",
        "denied-port: denied",
        "unix-socket: denied",
        "write-outside: denied",
        "signal: denied",
        "write-inside: allowed",
        "",
      ].join("\n"),
    );
    expect(text.stderr).toBe("");
    expect(text.code).toBe(0);
  });

  it("exits 1 and prints the reason when enforce would not work", () => {
    const text = formatSandboxCheck({
      ok: false,
      backend: "none",
      abi: null,
      reason: "Windows has no sandbox backend; enforce cannot run agents",
      probes: [],
    });
    expect(text.code).toBe(1);
    expect(text.stdout).toBe("backend: none\nabi: -\n");
    expect(text.stderr).toBe("Windows has no sandbox backend; enforce cannot run agents\n");
  });
});

describe("sandbox check exit codes", () => {
  it("exits 0 only when enforce would work", async () => {
    const ok = await capture(() => sandboxCommand(["check"], async () => passing));
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("backend: linux");
    expect(ok.stdout).toContain("abi: 6");
    for (const [id] of probes) expect(ok.stdout).toContain(`${id}:`);
    expect(ok.stderr).toBe("");

    const bad = await capture(() =>
      sandboxCommand(["check"], async () => ({
        ok: false,
        backend: "linux",
        abi: 3,
        reason: "landlock abi 3 is below 4",
        probes: [],
      })),
    );
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("backend: linux");
    expect(bad.stdout).toContain("abi: 3");
    expect(bad.stderr).toContain("landlock abi 3 is below 4");
  });

  it("prints help and does not run the check for --help", async () => {
    const assess = vi.fn();
    const help = await capture(() => sandboxCommand(["--help"], assess));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("sandbox check");
    expect(assess).not.toHaveBeenCalled();
  });

  it("exits 1 for an unknown sandbox command", async () => {
    const assess = vi.fn();
    const unknown = await capture(() => sandboxCommand(["status"], assess));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown command");
    expect(assess).not.toHaveBeenCalled();
  });
});
