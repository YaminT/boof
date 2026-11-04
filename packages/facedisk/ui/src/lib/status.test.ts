import { describe, expect, it } from "vitest";
import { statusLabel, statusTone } from "./status.js";

describe("status", () => {
  it("uses the product words", () => {
    expect(statusLabel("pending")).toBe("queued");
    expect(statusLabel("action")).toBe("needs you");
    expect(statusLabel("draft")).toBe("draft");
    expect(statusLabel("running")).toBe("running");
    expect(statusLabel("done")).toBe("done");
    expect(statusLabel("failed")).toBe("failed");
    expect(statusLabel("stopped")).toBe("stopped");
    expect(statusLabel("archived")).toBe("archived");
  });

  it("maps tones", () => {
    expect(statusTone("running")).toBe("running");
    expect(statusTone("action")).toBe("attention");
    expect(statusTone("done")).toBe("done");
    expect(statusTone("failed")).toBe("failed");
    for (const s of ["draft", "pending", "stopped", "archived"] as const) {
      expect(statusTone(s)).toBe("neutral");
    }
  });
});
