import { describe, expect, it } from "vitest";
import { readFocusMode, writeFocusMode } from "./focus-mode.js";

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};
const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("focus mode", () => {
  it("is simple by default", () => {
    expect(readFocusMode("tasks", memory())).toBe("simple");
    expect(readFocusMode("tasks", undefined)).toBe("simple");
  });
  it("reads exactly simple and expanded, from the versioned key", () => {
    const s = memory({ "boof:focus-mode:v1:tasks": "expanded" });
    expect(readFocusMode("tasks", s)).toBe("expanded");
    expect(readFocusMode("tasks", memory({ "boof:focus-mode:v1:tasks": "simple" }))).toBe("simple");
  });
  it("treats anything else as simple", () => {
    for (const v of ["", "Expanded", "true", "1", "expanded "])
      expect(readFocusMode("tasks", memory({ "boof:focus-mode:v1:tasks": v }))).toBe("simple");
  });
  it("keeps screens apart", () => {
    const s = memory();
    writeFocusMode("overview", "expanded", s);
    expect(readFocusMode("overview", s)).toBe("expanded");
    expect(readFocusMode("tasks", s)).toBe("simple");
    expect([...s.m.keys()]).toEqual(["boof:focus-mode:v1:overview"]);
  });
  it("survives storage that throws", () => {
    expect(readFocusMode("tasks", throwing)).toBe("simple");
    expect(() => writeFocusMode("tasks", "expanded", throwing)).not.toThrow();
    expect(() => writeFocusMode("tasks", "expanded", undefined)).not.toThrow();
  });
});
