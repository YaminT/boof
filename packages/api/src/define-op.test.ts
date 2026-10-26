import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL, type Principal, type Scope } from "@boof-runner/shared";
import { defineOp, type OpContext } from "./define-op.js";
import { OpError } from "./errors.js";
import { TaskService } from "./services/service.js";

let root: string;
let ctx: OpContext;
const principal = (scopes: Scope[], projects: "*" | string[] = "*"): Principal => ({
  kind: "client",
  id: "c1",
  name: "c1",
  scopes: new Set(scopes),
  projects: projects === "*" ? "*" : new Set(projects),
  trust: "trusted",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-defineop-"));
  ctx = {
    root,
    principal: LOCAL_PRINCIPAL,
    services: new TaskService(root),
    authStore: new AuthStore(root),
    now: () => "2026-01-01T00:00:00.000Z",
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const echo = (over: Partial<Parameters<typeof defineOp>[0]> = {}) =>
  defineOp({
    name: "test.echo",
    title: "Echo",
    description: "Echoes a number. Input: n. No side effects.",
    scope: "tasks:read",
    projectScoped: true,
    input: z.strictObject({ projectId: z.string(), n: z.number().int() }),
    output: z.object({ n: z.number() }),
    rest: { method: "GET", path: "/echo/{projectId}" },
    mcp: { expose: false },
    handler: async (_c, input) => ({ n: input.n }),
    ...over,
  } as never);

describe("defineOp", () => {
  it("validates input, runs the handler and returns the validated output", async () => {
    const op = echo();
    expect(await op.execute(ctx, { projectId: "p", n: 3 })).toEqual({ n: 3 });
    const err = await op.execute(ctx, { projectId: "p", n: "3" }).catch((e) => e);
    expect(err).toBeInstanceOf(OpError);
    expect(err).toMatchObject({ status: 400, code: "invalid_input" });
    expect(err.details[0].path).toBe("n");
    await expect(op.execute(ctx, { projectId: "p", n: 1, extra: 1 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("checks the scope (any of several) and the project before running", async () => {
    let ran = 0;
    const op = echo({
      scope: ["tasks:read", "plans:read"],
      handler: async (_c: OpContext, i: { n: number }) => {
        ran += 1;
        return { n: i.n };
      },
    } as never);
    const none = { ...ctx, principal: principal(["settings:read"]) };
    await expect(op.execute(none, { projectId: "p", n: 1 })).rejects.toMatchObject({
      status: 403,
      code: "forbidden_scope",
      details: { anyOf: ["tasks:read", "plans:read"] },
    });
    const wrongProject = { ...ctx, principal: principal(["plans:read"], ["other"]) };
    await expect(op.execute(wrongProject, { projectId: "p", n: 1 })).rejects.toMatchObject({
      status: 403,
      code: "forbidden_project",
    });
    expect(ran).toBe(0);
    const ok = { ...ctx, principal: principal(["plans:read"], ["p"]) };
    await expect(op.execute(ok, { projectId: "p", n: 1 })).resolves.toEqual({ n: 1 });
    expect(
      await op.execute({ ...ctx, principal: principal(["admin"]) }, { projectId: "p", n: 2 }),
    ).toEqual({ n: 2 });
  });

  it("refuses a handler result that violates the output schema", async () => {
    const op = echo({ handler: async () => ({ n: "nope" }) } as never);
    const quiet = console.error;
    console.error = () => {};
    try {
      await expect(op.execute(ctx, { projectId: "p", n: 1 })).rejects.toMatchObject({
        status: 500,
        code: "internal",
      });
    } finally {
      console.error = quiet;
    }
  });

  it("maps thrown errors to OpError and hides unknown ones", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const known = echo({
        handler: async () => {
          throw new OpError(409, "busy", "project_busy", { a: 1 });
        },
      } as never);
      await expect(known.execute(ctx, { projectId: "p", n: 1 })).rejects.toMatchObject({
        status: 409,
        code: "project_busy",
        details: { a: 1 },
      });
      const unknown = echo({
        handler: async () => {
          throw new Error("secret /etc/passwd detail");
        },
      } as never);
      const err = await unknown.execute(ctx, { projectId: "p", n: 1 }).catch((e) => e);
      expect(err.toBody()).toEqual({ error: { code: "internal", message: "Internal error" } });
    } finally {
      console.error = quiet;
    }
  });

  it("uses the operation's invalid-input code, but invalid_input for path parameters", async () => {
    const op = echo({
      invalidInputCode: "invalid_plan",
      rest: { method: "GET", path: "/echo/{projectId}" },
    } as never);
    await expect(op.execute(ctx, { projectId: "p", n: "x" })).rejects.toMatchObject({
      code: "invalid_plan",
    });
    await expect(op.execute(ctx, { projectId: 5, n: 1 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("requires a valid MCP name when exposed", () => {
    expect(() => echo({ mcp: { expose: true } } as never)).toThrow(/mcp.name/);
    expect(() => echo({ mcp: { expose: true, name: "has space" } } as never)).toThrow(/mcp.name/);
    expect(() => echo({ mcp: { expose: true, name: "boof_echo_it" } } as never)).not.toThrow();
  });
});
