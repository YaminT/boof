import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { accountsPage } from "./settings-accounts.js";

const settings = {
  owlish: { url: "http://127.0.0.1:4390", healthGate: "pause" as const },
} as Settings;
const project = {} as Project;

describe("Accounts settings draft", () => {
  it("starts from the optional gateway and validates its URL", () => {
    expect(accountsPage.values(settings, project).global).toEqual({
      enabled: true,
      url: "http://127.0.0.1:4390",
      healthGate: "pause",
    });
    expect(
      accountsPage.problems({
        global: { enabled: true, url: "bad", healthGate: "pause" },
        project: {},
      }),
    ).toContain("Enter a valid gateway URL.");
    expect(
      accountsPage.problems({
        global: { enabled: false, url: "bad", healthGate: "off" },
        project: {},
      }),
    ).toEqual([]);
  });

  it("patches only changed gateway settings and clears on disable", () => {
    const base = accountsPage.values(settings, project);
    const latest = { settings, project };
    expect(
      accountsPage.patches(
        { ...base, global: { ...base.global, healthGate: "warn" } },
        base,
        latest,
      ),
    ).toEqual({
      settings: { owlish: { url: "http://127.0.0.1:4390", healthGate: "warn" } },
    });
    expect(
      accountsPage.patches({ ...base, global: { ...base.global, enabled: false } }, base, latest),
    ).toEqual({ settings: { owlish: null } });
  });
});
