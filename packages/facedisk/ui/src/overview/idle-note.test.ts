import { describe, expect, it } from "vitest";
import { idleQueueNote } from "./idle-note.js";

describe("idleQueueNote", () => {
  it("explains a non-empty queue while the runner is on", () => {
    expect(idleQueueNote(2, false, false)).toBe(
      "2 tasks are queued. The runner starts the next one when a slot is free.",
    );
    expect(idleQueueNote(1, false, false)).toMatch(/^1 task is queued\./);
  });

  it("is quiet when the queue is empty or something is paused", () => {
    expect(idleQueueNote(0, false, false)).toBeNull();
    expect(idleQueueNote(3, true, false)).toBeNull();
    expect(idleQueueNote(3, false, true)).toBeNull();
  });
});
