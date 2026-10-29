import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL, type Principal, type Scope } from "@boof-runner/shared";
import { MockTool, ToolRegistry, type Tool } from "@boof-runner/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

let root: string;
let ctx: OpContext;
let detectCalls: number;

/** A tool whose live list adds one model and whose defaults include two. */
function fakeTool(over: Partial<Tool> = {}): Tool {
  return {
    id: "fake",
    displayName: "Fake Tool",
    defaultModels: ["fake-a", "fake-b"],
    detect: async () => {
      detectCalls += 1;
      return { status: "available", message: "fake ok", version: "9.9.9" };
    },
    listModels: async () => ["fake-a", "fake-live"],
    run: async () => {
      throw new Error("not used");
    },
    ...over,
  } as Tool;
}

/** A repository for a project; it must sit outside the data root. */
async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boof-models-wd-"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

const principal = (scopes: Scope[], projects: "*" | string[] = "*"): Principal => ({
  kind: "client",
  id: "c1",
  name: "c1",
  scopes: new Set(scopes),
  projects: projects === "*" ? "*" : new Set(projects),
  trust: "trusted",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-models-"));
  detectCalls = 0;
  ctx = {
    root,
    principal: LOCAL_PRINCIPAL,
    services: new TaskService(root, new ToolRegistry([new MockTool(), fakeTool()])),
    authStore: new AuthStore(root),
    now: () => "2026-01-01T00:00:00.000Z",
  };
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Settings: fake tool planner on its live model, reviewer on a default; a user-added model. */
async function configure() {
  await ctx.services.updateSettings({
    roles: {
      planner: { tool: "fake", model: "fake-live" },
      developer: { tool: "mock", model: "mock-default" },
      reviewer: { tool: "fake", model: "fake-b" },
    },
    models: { fake: ["fake-live", "fake-custom"], mock: ["mock-default"] },
  });
}

const details = async (c: OpContext = ctx) => {
  const op = getOp("models.details");
  if (!op) throw new Error("models.details is not registered");
  return (await op.execute(c, {})) as {
    tools: Record<
      string,
      {
        displayName: string;
        health: { status: string; version?: string; checkedAt: string } | null;
        models: { id: string; source: string; isDefault: boolean; usedBy: string[] }[];
      }
    >;
  };
};

const model = (
  out: Awaited<ReturnType<typeof details>>,
  tool: string,
  id: string,
): { id: string; source: string; isDefault: boolean; usedBy: string[] } => {
  const found = out.tools[tool]?.models.find((m) => m.id === id);
  if (!found) throw new Error(`${tool} has no model ${id}`);
  return found;
};

describe("models.details operation", () => {
  it("is a settings read, REST GET /models/details, not exposed over MCP", () => {
    const op = getOp("models.details");
    expect(op?.scopes).toEqual(["settings:read"]);
    expect(op?.rest).toMatchObject({ method: "GET", path: "/models/details" });
    expect(op?.mcp.expose).toBe(false);
  });

  it("labels each model by source and marks the tool's first default", async () => {
    await configure();
    const out = await details();
    expect(out.tools.fake.displayName).toBe("Fake Tool");
    expect(model(out, "fake", "fake-a")).toMatchObject({ source: "cli", isDefault: true });
    expect(model(out, "fake", "fake-live")).toMatchObject({ source: "cli", isDefault: false });
    expect(model(out, "fake", "fake-b")).toMatchObject({ source: "default", isDefault: false });
    expect(model(out, "fake", "fake-custom")).toMatchObject({
      source: "settings",
      isDefault: false,
    });
    expect(model(out, "mock", "mock-default")).toMatchObject({ source: "cli", isDefault: true });
  });

  it("falls back to defaults when a live listing fails, so only user models stay settings", async () => {
    await configure();
    ctx = {
      ...ctx,
      services: new TaskService(
        root,
        new ToolRegistry([
          fakeTool({
            listModels: async () => {
              throw new Error("cli missing");
            },
          }),
        ]),
      ),
    };
    const out = await details();
    expect(model(out, "fake", "fake-a")).toMatchObject({ source: "default", isDefault: true });
    expect(model(out, "fake", "fake-b").source).toBe("default");
    expect(model(out, "fake", "fake-live").source).toBe("settings");
    expect(model(out, "fake", "fake-custom").source).toBe("settings");
  });

  it("lists the roles that use a tool and model, and project overrides", async () => {
    await configure();
    await ctx.services.createProject({
      workingDirectory: await workdir(),
      id: "alpha",
      roles: { developer: { tool: "fake", model: "fake-b" } },
    });
    const out = await details();
    expect(model(out, "fake", "fake-live").usedBy).toEqual(["planner"]);
    expect(model(out, "fake", "fake-b").usedBy).toEqual(["reviewer", "project:alpha:developer"]);
    expect(model(out, "fake", "fake-a").usedBy).toEqual([]);
    expect(model(out, "mock", "mock-default").usedBy).toEqual(["developer"]);
  });

  it("omits project overrides of projects the caller may not access", async () => {
    await configure();
    await ctx.services.createProject({ workingDirectory: await workdir(), id: "alpha" });
    await ctx.services.createProject({
      workingDirectory: await workdir(),
      id: "beta",
      roles: { planner: { tool: "fake", model: "fake-secret" } },
    });
    const restricted: OpContext = { ...ctx, principal: principal(["settings:read"], ["alpha"]) };
    const out = await details(restricted);
    expect(out.tools.fake.models.map((m) => m.id)).not.toContain("fake-secret");
    const all = await details();
    expect(all.tools.fake.models.map((m) => m.id)).toContain("fake-secret");
    expect(model(all, "fake", "fake-secret")).toMatchObject({
      source: "settings",
      usedBy: ["project:beta:planner"],
    });
  });

  it("reports health as null until a health check ran, then the cached result with its time", async () => {
    await configure();
    const before = await details();
    expect(before.tools.fake.health).toBeNull();
    expect(before.tools.mock.health).toBeNull();
    expect(detectCalls).toBe(0);

    const start = Date.now();
    await ctx.services.health();
    const after = await details();
    expect(detectCalls).toBe(1);
    expect(after.tools.mock.health).toMatchObject({ status: "available", version: "1.0.0" });
    expect(after.tools.fake.health).toMatchObject({ status: "available", version: "9.9.9" });
    const checked = Date.parse(after.tools.fake.health!.checkedAt);
    expect(checked).toBeGreaterThanOrEqual(start - 1000);
    expect(checked).toBeLessThanOrEqual(Date.now());
  });

  it("runs no health probe and no smoke prompt itself", async () => {
    await configure();
    await details();
    await details();
    expect(detectCalls).toBe(0);
  });

  it("leaves the plain model listing (GET /models) unchanged", async () => {
    await configure();
    const plain = await ctx.services.listModels();
    expect(plain.fake).toEqual(["fake-a", "fake-live"]);
    expect(plain.mock).toEqual(["mock-default"]);
  });
});
