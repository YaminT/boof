import { describe, expect, it } from "vitest";
import { settingsPageAccess } from "./settings-access.js";

describe("settingsPageAccess", () => {
  it("lets the key and automation pages load their own data without settings", () => {
    expect(settingsPageAccess("keys", false)).toBe("own");
    expect(settingsPageAccess("automation", false)).toBe("own");
  });
  it("the forms need the settings", () => {
    for (const page of ["project", "agents", "budgets"] as const) {
      expect(settingsPageAccess(page, false)).toBe("needs-settings-read");
      expect(settingsPageAccess(page, true)).toBe("forms");
    }
  });
});
