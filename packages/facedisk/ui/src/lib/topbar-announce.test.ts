import { describe, expect, it } from "vitest";
import { announcementOf } from "./topbar-announce.js";

describe("announcementOf", () => {
  it("does not change with the step or the queue count inside one state", () => {
    expect(announcementOf({ tone: "working", text: "Working · Step 2: tests" }, "Working")).toBe(
      announcementOf({ tone: "working", text: "Working · Step 3: lint" }, "Working"),
    );
    expect(announcementOf({ tone: "idle", text: "Idle · 3 queued" }, "Idle")).toBe("Idle");
  });
  it("says the reason for a state that has one", () => {
    expect(announcementOf({ tone: "blocked", text: "Cannot run: no agent" }, "Cannot")).toBe(
      "Cannot run: no agent",
    );
    expect(announcementOf({ tone: "paused", text: "Paused · 2 queued" }, "Paused")).toBe(
      "Paused · 2 queued",
    );
  });
});
