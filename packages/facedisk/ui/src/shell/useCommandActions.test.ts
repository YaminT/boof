import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStopPending,
  isStopPending,
  markStopPending,
  stopDisabled,
} from "../lib/stop-request.js";

vi.mock("../lib/act.js", () => ({
  act: async (request: () => Promise<unknown>) => {
    try {
      return await request();
    } catch {
      return undefined;
    }
  },
}));

import { requestPaletteStop } from "../lib/palette-stop.js";

describe("palette stop failure", () => {
  beforeEach(() => clearStopPending("project", "task"));

  it("clears the latch so Stop is enabled again", async () => {
    markStopPending("project", "task");

    await requestPaletteStop("project", "task", async () => {
      throw new Error("HTTP 500");
    });

    expect(isStopPending("project", "task")).toBe(false);
    expect(stopDisabled("running", isStopPending("project", "task"))).toBe(false);
  });
});
