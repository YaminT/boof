import { describe, expect, it } from "vitest";
import { registry } from "@boof-runner/api";
import { OP_COVERAGE } from "../ui/src/op-coverage.js";

describe("UI coverage of the operations", () => {
  it("has exactly one entry per registry operation", () => {
    expect(Object.keys(OP_COVERAGE)).toEqual(registry.map((o) => o.name));
  });

  it("gives every entry a non-empty where or none", () => {
    for (const [name, v] of Object.entries(OP_COVERAGE)) {
      const text = "where" in v ? v.where : v.none;
      expect(text.trim().length, name).toBeGreaterThan(10);
    }
  });

  it("lists the operations the UI does not do (adding one is a reviewed decision)", () => {
    const none = Object.entries(OP_COVERAGE)
      .filter(([, v]) => "none" in v)
      .map(([k]) => k);
    expect(none).toMatchInlineSnapshot(`
      [
        "auth.whoami",
        "projects.unarchive",
        "projects.pause",
        "projects.resume",
        "projects.delete",
        "plans.replaceGoals",
        "plans.wait",
        "tasks.move",
        "tasks.wait",
        "epics.list",
        "epics.get",
        "epics.create",
        "epics.update",
        "epics.delete",
        "settings.health",
        "settings.models",
        "runner.status",
        "runner.overview",
        "auth.clients.rotate",
        "webhooks.list",
        "webhooks.create",
        "webhooks.delete",
      ]
    `);
  });
});
