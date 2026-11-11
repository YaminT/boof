import { describe, expect, it } from "vitest";
import { resetSandboxStatus, sandboxOffer, setSandboxOffer } from "./sandbox-launch.js";

describe("sandbox offer", () => {
  it("stays false until a check sets it, and reset clears it", () => {
    resetSandboxStatus();
    expect(sandboxOffer()).toBe(false);
    setSandboxOffer(true);
    expect(sandboxOffer()).toBe(true);
    resetSandboxStatus();
    expect(sandboxOffer()).toBe(false);
  });
});
