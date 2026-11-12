import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTool, ToolRegistry } from "@boof/runner";
import { doctorCommand, type DoctorCatalog } from "./doctor-cli.js";

const catalog = (installed: boolean): DoctorCatalog => ({
  list: () => [{ id: "claude-code", displayName: "Claude Code" }],
  installedAll: async () => ({
    "claude-code": {
      installed,
      message: installed ? "installed" : "`claude` not found on PATH",
      ...(installed ? { version: "9.9.9", path: "/x/claude" } : {}),
      checkedAt: "2026-11-12T00:00:00.000Z",
    },
  }),
});

afterEach(() => vi.restoreAllMocks());

describe("boof-runner doctor", () => {
  it("prints each harness and the PATH, and exits 0 when one is installed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await doctorCommand([], catalog(true), { PATH: "/a:/b" })).toBe(0);
    const out = log.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("claude-code");
    expect(out).toContain("9.9.9");
    expect(out).toContain("/x/claude");
    expect(out).toContain("PATH: /a:/b");
  });

  it("exits 1 when none is installed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await doctorCommand([], catalog(false), { PATH: "/a" })).toBe(1);
    expect(err.mock.calls.join("\n")).toContain("No coding agent found");
  });

  it("--json prints a parseable document", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await doctorCommand(["--json"], catalog(true), { PATH: "/a" })).toBe(0);
    const doc = JSON.parse(String(log.mock.calls[0]![0]));
    expect(doc).toMatchObject({ anyInstalled: true, path: "/a" });
    expect(doc.tools["claude-code"]).toMatchObject({ installed: true, version: "9.9.9" });
  });

  it("refuses unknown words and flags", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await doctorCommand(["nope"], catalog(true), {})).toBe(1);
    expect(await doctorCommand(["--bad"], catalog(true), {})).toBe(1);
  });

  it("does not count the mock tool as an installed agent (exit 1, no mock row)", async () => {
    const saved = process.env.BOOF_SHOW_MOCK_TOOL;
    delete process.env.BOOF_SHOW_MOCK_TOOL;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await doctorCommand([], new ToolRegistry([new MockTool()]), { PATH: "" })).toBe(1);
      expect(log.mock.calls.map((c) => c[0]).join("\n")).not.toContain("mock");
      process.env.BOOF_SHOW_MOCK_TOOL = "1";
      expect(await doctorCommand([], new ToolRegistry([new MockTool()]), { PATH: "" })).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.BOOF_SHOW_MOCK_TOOL;
      else process.env.BOOF_SHOW_MOCK_TOOL = saved;
    }
  });
});
