import { describe, expect, it } from "vitest";
import { runnerBanner } from "./runner-banner.js";

describe("runnerBanner", () => {
  it("says started only when the runner is enabled", () => {
    expect(runnerBanner({ engine: true, enabled: true, noRunner: false })).toMatch(/started/);
    const paused = runnerBanner({ engine: true, enabled: false, noRunner: false });
    expect(paused).toMatch(/paused/);
    expect(paused).not.toMatch(/started/);
  });
  it("reports another process, and stays quiet with --no-runner", () => {
    expect(runnerBanner({ engine: false, enabled: true, noRunner: false })).toMatch(/another/);
    expect(runnerBanner({ engine: false, enabled: true, noRunner: true })).toBeNull();
  });
});
