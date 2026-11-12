import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./errors.js";
import { MCP_NAME } from "./define-op.js";
import { registry } from "./registry.js";
import { SCOPES } from "@boof/heart";

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
      expect(op.name, op.name).toMatch(/^[a-z][a-z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/);
      expect(op.rest.path.startsWith("/"), op.name).toBe(true);
      // Path placeholders are input fields; project-scoped operations take a projectId.
      const shape = Object.keys((op.input as { shape: object }).shape);
      for (const p of op.pathParams) expect(shape, `${op.name} ${p}`).toContain(p);
      if (op.projectScoped) expect(shape, op.name).toContain("projectId");
    }
  });

  it("scopes every operation with a projectId input to its project, except the listed globals", () => {
    // Operations that take a projectId but act on the whole server; none today.
    const GLOBAL_WITH_PROJECT_ID: string[] = [];
    for (const op of registry) {
      const shape = Object.keys((op.input as { shape: object }).shape);
      if (shape.includes("projectId") && !GLOBAL_WITH_PROJECT_ID.includes(op.name)) {
        expect(op.projectScoped, `${op.name} takes projectId but is not projectScoped`).toBe(true);
      }
    }
  });

  it("gives every exposed operation a stable MCP-safe name, annotations and a summary", () => {
    const names: string[] = [];
    for (const op of registry.filter((o) => o.mcp.expose)) {
      expect(op.mcp.name, op.name).toMatch(MCP_NAME);
      expect(op.mcp.name, op.name).toMatch(/^boof_[a-z0-9]+(_[a-z0-9_]+)?$/);
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

  it("pins the hierarchy tool names", () => {
    const byName = Object.fromEntries(registry.map((o) => [o.name, o.mcp.name]));
    expect(byName).toMatchObject({
      "epics.list": "boof_list_epics",
      "epics.create": "boof_create_epic",
      "tasks.move": "boof_move_task",
    });
  });

  it("exposes every operation on MCP except file upload and download", () => {
    for (const op of registry) {
      const json = !op.rest.kind || op.rest.kind === "json";
      expect(op.mcp.expose, op.name).toBe(json && !op.mcp.why);
      if (op.mcp.why)
        expect(
          /^(concierge|harnesses|plans\.draftGoals|projects\.detectStack)/.test(op.name),
          op.name,
        ).toBe(true);
    }
  });

  it("never names a key or secret in an MCP summary", () => {
    const create = registry.find((o) => o.name === "auth.clients.create")!;
    const text = create.summary!({
      client: { id: "x", scopes: ["tasks:read"], trust: "review" } as never,
      key: "boof_x_SECRET",
    });
    expect(text).not.toContain("SECRET");
    expect(text).toContain("shown only once");
    const rotate = registry.find((o) => o.name === "auth.clients.rotate")!;
    expect(rotate.summary!({ client: { id: "x" } as never, key: "boof_x_SECRET" })).not.toContain(
      "SECRET",
    );
    const hook = registry.find((o) => o.name === "webhooks.create")!;
    const text2 = hook.summary!({
      webhook: {
        id: "wh-1",
        url: "https://hooks.slack.com/services/T000/B000/SECRETPATH?x=1",
      } as never,
      secret: "whsec_SECRET",
    });
    expect(text2).not.toContain("SECRETPATH");
    expect(text2).toContain("https://hooks.slack.com/…");
    expect(
      hook.summary!({ webhook: { id: "wh-1", url: "http://h" } as never, secret: "whsec_SECRET" }),
    ).not.toContain("SECRET");
  });

  it("uses only error codes from the table", () => {
    for (const op of registry) {
      if (op.invalidInputCode)
        expect(Object.keys(ERROR_CODES), op.name).toContain(op.invalidInputCode);
    }
  });
});
