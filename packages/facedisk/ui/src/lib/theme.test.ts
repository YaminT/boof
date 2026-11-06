import { describe, expect, it } from "vitest";
import { resolveTheme, themePrefFromStorage } from "./theme.js";

describe("resolveTheme", () => {
  it("follows the system when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
  it("reads a stored preference and treats anything else as system", () => {
    expect(themePrefFromStorage("dark")).toBe("dark");
    expect(themePrefFromStorage("light")).toBe("light");
    expect(themePrefFromStorage(null)).toBe("system");
    expect(themePrefFromStorage("nope")).toBe("system");
  });
  it("an explicit preference wins over the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
