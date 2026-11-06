import { describe, expect, it } from "vitest";
import { parseInjected } from "./injected";

describe("parseInjected", () => {
  it("is empty for an empty section", () => {
    expect(parseInjected("")).toEqual([]);
    expect(parseInjected("stray text")).toEqual([]);
  });

  it("reads who, when, mode and applied time", () => {
    const md = [
      "### 2026-10-29T10:00:00.000Z — user",
      "",
      "use tabs",
      "",
      "### 2026-10-29T10:05:00.000Z — alice",
      "",
      "<!-- boof: mode=now applied=2026-10-29T10:05:03.000Z -->",
      "stop and rethink",
      "second line",
    ].join("\n");
    expect(parseInjected(md)).toEqual([
      { at: "2026-10-29T10:00:00.000Z", by: "user", text: "use tabs", mode: "next-step" },
      {
        at: "2026-10-29T10:05:00.000Z",
        by: "alice",
        text: "stop and rethink\nsecond line",
        mode: "now",
        appliedAt: "2026-10-29T10:05:03.000Z",
      },
    ]);
  });

  it("treats a next-step marker without applied as waiting", () => {
    const [e] = parseInjected(
      "### 2026-10-29T10:00:00Z — user\n\n<!-- boof: mode=next-step -->\nhi",
    );
    expect(e).toMatchObject({ mode: "next-step", text: "hi" });
    expect(e.appliedAt).toBeUndefined();
  });
});
