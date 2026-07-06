import { describe, expect, it } from "vitest";
import { toKebabId, uniqueKebabId } from "./ids.js";

describe("toKebabId", () => {
  it("converts a title to kebab-case", () => {
    expect(toKebabId("Add User Authentication!")).toBe("add-user-authentication");
  });

  it("strips illegal characters and collapses hyphens", () => {
    expect(toKebabId("  Foo / Bar @@ Baz  ")).toBe("foo-bar-baz");
  });

  it("handles all-illegal input by returning empty", () => {
    expect(toKebabId("@#$%")).toBe("");
  });
});

describe("uniqueKebabId", () => {
  it("returns the base id when free", () => {
    expect(uniqueKebabId("Add Auth", [])).toBe("add-auth");
  });

  it("appends a numeric suffix on collision", () => {
    expect(uniqueKebabId("Add Auth", ["add-auth"])).toBe("add-auth-2");
    expect(uniqueKebabId("Add Auth", ["add-auth", "add-auth-2"])).toBe("add-auth-3");
  });

  it("falls back to 'task' for empty derived ids", () => {
    expect(uniqueKebabId("@#$", [])).toBe("task");
  });
});
