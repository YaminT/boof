import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./errors.js";
import { MCP_NAME } from "./define-op.js";
import { registry } from "./registry.js";
import { SCOPES } from "@boof-runner/shared";

describe("operations registry contract", () => {
  it("has unique names and unique REST routes", () => {
    expect(new Set(registry.map((o) => o.name)).size).toBe(registry.length);
    const routes = registry.map((o) => `${o.rest.method} ${o.rest.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("declares a known scope, a description and a REST mapping for every operation", () => {
    for (const op of registry) {
      for (const s of op.scopes) expect(SCOPES, op.name).toContain(s);
      expect(op.description.length, op.name).toBeGreaterThan(20);
      expect(op.name, op.name).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
      expect(op.rest.path.startsWith("/"), op.name).toBe(true);
      // Path placeholders are input fields; project-scoped operations take a projectId.
      const shape = Object.keys((op.input as { shape: object }).shape);
      for (const p of op.pathParams) expect(shape, `${op.name} ${p}`).toContain(p);
      if (op.projectScoped) expect(shape, op.name).toContain("projectId");
    }
  });

  it("gives every exposed operation a stable MCP-safe name, annotations and a summary", () => {
    const names: string[] = [];
    for (const op of registry.filter((o) => o.mcp.expose)) {
      expect(op.mcp.name, op.name).toMatch(MCP_NAME);
      expect(op.mcp.name, op.name).toMatch(/^boof_[a-z]+(_[a-z_]+)?$/);
      expect(op.mcp.annotations, op.name).toBeDefined();
      expect(op.summary, op.name).toBeTypeOf("function");
      names.push(op.mcp.name!);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("pins the harness-flow tool names (renaming one breaks MCP clients)", () => {
    const byName = Object.fromEntries(registry.map((o) => [o.name, o.mcp.name]));
    expect(byName).toMatchObject({
      "projects.create": "boof_create_project",
      "plans.create": "boof_create_plan",
      "plans.sync": "boof_sync_plan",
      "plans.upsertGoal": "boof_upsert_goal",
      "tasks.get": "boof_get_task",
      "tasks.answers": "boof_answer_task",
    });
  });

  it("does not expose admin-only operations, secrets or file transfer to MCP", () => {
    for (const op of registry) {
      if (op.scopes.includes("admin") || op.scopes.includes("auth:admin")) {
        expect(op.mcp.expose, op.name).toBe(false);
      }
      if (op.rest.kind) expect(op.mcp.expose, op.name).toBe(false);
    }
  });

  it("uses only error codes from the table", () => {
    for (const op of registry) {
      if (op.invalidInputCode)
        expect(Object.keys(ERROR_CODES), op.name).toContain(op.invalidInputCode);
    }
  });
});
