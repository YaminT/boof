import { describe, expect, it, vi } from "vitest";
import { SELF_TEST_PROBES } from "./selftest.js";
import { assessSandbox } from "./check.js";

const passing = SELF_TEST_PROBES.map((id) => ({
  id,
  outcome: id === "write-inside" ? "allowed" : "denied",
}));

describe("assessSandbox", () => {
  it("reports windows as not able to enforce, and does not spawn", async () => {
    const spawn = vi.fn();
    const probes = vi.fn();
    const report = await assessSandbox({ platform: "win32", spawn, probes });
    expect(report).toEqual({
      ok: false,
      backend: "none",
      abi: null,
      reason: "Windows has no sandbox backend; enforce cannot run agents",
      probes: [],
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
  });

  it("reports a missing sandbox-exec without running probes", async () => {
    const probes = vi.fn();
    const report = await assessSandbox({
      platform: "darwin",
      sandboxExecExists: () => false,
      probes,
    });
    expect(report).toEqual({
      ok: false,
      backend: "darwin",
      abi: null,
      reason: "sandbox-exec is missing",
      probes: [],
    });
    expect(probes).not.toHaveBeenCalled();
  });

  it("passes a macOS self-test without a Landlock ABI, and ignores the Linux ABI knob", async () => {
    const report = await assessSandbox({
      platform: "darwin",
      env: { BOOF_SANDBOX_FAKE_ABI: "3" },
      sandboxExecExists: () => true,
      probes: async () => passing,
    });
    expect(report.ok).toBe(true);
    expect(report.backend).toBe("darwin");
    expect(report.abi).toBeNull();
    expect(report.reason).toBe("");
    expect(report.probes.map((probe) => probe.id)).toEqual([...SELF_TEST_PROBES]);
  });

  it("reports a missing helper without running probes", async () => {
    const probes = vi.fn();
    const report = await assessSandbox({
      platform: "linux",
      env: {},
      helperExists: () => false,
      helperPath: () => "/no/such/boof-sandbox",
      probes,
    });
    expect(report.ok).toBe(false);
    expect(report.backend).toBe("linux");
    expect(report.abi).toBeNull();
    expect(report.reason).toBe("boof-sandbox helper is missing");
    expect(report.probes).toEqual([]);
    expect(probes).not.toHaveBeenCalled();
  });

  it("returns the ABI and every probe when enforce would work", async () => {
    const report = await assessSandbox({
      platform: "linux",
      env: { BOOF_SANDBOX_FAKE_ABI: "6" },
      helperExists: () => true,
      helperPath: () => "/helper",
      probes: async () => passing,
    });
    expect(report.ok).toBe(true);
    expect(report.backend).toBe("linux");
    expect(report.abi).toBe(6);
    expect(report.reason).toBe("");
    expect(report.probes.map((probe) => probe.id)).toEqual([...SELF_TEST_PROBES]);
  });

  it("is not ok when a denial probe is allowed", async () => {
    const report = await assessSandbox({
      platform: "linux",
      env: { BOOF_SANDBOX_FAKE_ABI: "6" },
      helperExists: () => true,
      helperPath: () => "/helper",
      probes: async () =>
        passing.map((probe) =>
          probe.id === "data-root-read" ? { ...probe, outcome: "allowed" } : probe,
        ),
    });
    expect(report.ok).toBe(false);
    expect(report.abi).toBe(6);
    expect(report.reason).toBe("self-test: read a file inside the data root");
  });
});
