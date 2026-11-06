import { describe, expect, it } from "vitest";
import { stopDisabled } from "./stop-request.js";

describe("stopDisabled", () => {
  it("stays disabled from the request until the task leaves running", () => {
    expect(stopDisabled("running", true)).toBe(true);
    expect(stopDisabled("stopped", true)).toBe(false);
    expect(stopDisabled("failed", true)).toBe(false);
    expect(stopDisabled("done", true)).toBe(false);
  });

  it("enables Stop again when the request fails, while the task is still running", () => {
    expect(stopDisabled("running", false)).toBe(false);
  });
});
