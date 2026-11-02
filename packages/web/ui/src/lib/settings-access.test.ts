import { describe, expect, it } from "vitest";
import { settingsPageAccess } from "./settings-access.js";

const all = { settings: true, project: true };

describe("settingsPageAccess", () => {
  it("lets the key and automation pages load their own data, with or without settings and projects", () => {
    for (const page of ["keys", "automation"] as const) {
      expect(settingsPageAccess(page, { settings: false, project: false })).toBe("own");
      expect(settingsPageAccess(page, all)).toBe("own");
    }
  });
  it("the forms need a project first, then the settings", () => {
    for (const page of ["project", "agents", "budgets"] as const) {
      expect(settingsPageAccess(page, { settings: true, project: false })).toBe(
        "needs-projects-read",
      );
      expect(settingsPageAccess(page, { settings: false, project: false })).toBe(
        "needs-projects-read",
      );
      expect(settingsPageAccess(page, { settings: false, project: true })).toBe(
        "needs-settings-read",
      );
      expect(settingsPageAccess(page, all)).toBe("forms");
    }
  });
});
