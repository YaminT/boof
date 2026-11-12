import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, LOCAL_PRINCIPAL } from "@boof/heart";
import { MockTool, ToolRegistry, type Tool } from "@boof/runner";
import type { OpContext } from "../define-op.js";
import { getOp } from "../registry.js";
import { TaskService } from "../services/service.js";

let root: string;
let ctx: OpContext;
let checks: number;

const fake = (installed: boolean): Tool =>
  ({
    id: "fake",
    displayName: "Fake Tool",
    defaultModels: [],
    installed: async () => {
      checks += 1;
      return installed
        ? {
            installed: true,
            version: "1.0",
            path: "/x/fake",
            foundOffPath: "/x/fake",
            message: "m",
          }
        : { installed: false, message: "not found" };
    },
    detect: async () => {
      throw new Error("a health probe must not run");
    },
    listModels: async () => [],
    run: async () => {
      throw new Error("not used");
    },
  }) as Tool;

const setup = async (tool: Tool, tools: Tool[] = [tool]) => {
  root = await mkdtemp(join(tmpdir(), "boof-harnesses-"));
  checks = 0;
  ctx = {
    root,
    principal: LOCAL_PRINCIPAL,
    services: new TaskService(root, new ToolRegistry(tools)),
    authStore: new AuthStore(root),
    now: () => "2026-01-01T00:00:00.000Z",
  };
};
beforeEach(() => {
  checks = 0;
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("harnesses.status operation", () => {
  it("is REST-only, needs settings:read and has no project scope", async () => {
    await setup(fake(true));
    const op = getOp("harnesses.status");
    expect(op?.scopes).toEqual(["settings:read"]);
    expect(op?.mcp.expose).toBe(false);
    expect(op?.rest).toMatchObject({ method: "GET", path: "/harnesses" });
  });

  it("reports installed tools, anyInstalled and the off-PATH path, without a health probe", async () => {
    await setup(fake(true));
    const out = (await getOp("harnesses.status")!.execute(ctx, {})) as {
      tools: Record<string, { installed: boolean; foundOffPath?: string; displayName: string }>;
      anyInstalled: boolean;
      checkedAt: string;
    };
    expect(out.anyInstalled).toBe(true);
    expect(out.tools.fake).toMatchObject({
      installed: true,
      displayName: "Fake Tool",
      foundOffPath: "/x/fake",
    });
    expect(Number.isNaN(Date.parse(out.checkedAt))).toBe(false);
  });

  it("says anyInstalled false when nothing is installed, caches, and refresh is rate-limited", async () => {
    await setup(fake(false));
    const run = (refresh?: boolean) =>
      getOp("harnesses.status")!.execute(ctx, refresh === undefined ? {} : { refresh }) as Promise<{
        anyInstalled: boolean;
      }>;
    expect((await run()).anyInstalled).toBe(false);
    await run();
    expect(checks).toBe(1);
    await run(true);
    expect(checks).toBe(1);
  });

  it("hides the mock tool: it is not an installed agent unless a dev flag is set", async () => {
    const saved = process.env.BOOF_SHOW_MOCK_TOOL;
    delete process.env.BOOF_SHOW_MOCK_TOOL;
    try {
      await setup(fake(false), [new MockTool(), fake(false)]);
      const out = (await getOp("harnesses.status")!.execute(ctx, {})) as {
        tools: Record<string, { installed: boolean }>;
        anyInstalled: boolean;
      };
      expect(out.tools.mock).toBeUndefined();
      expect(out.tools.fake.installed).toBe(false);
      expect(out.anyInstalled).toBe(false);
    } finally {
      if (saved !== undefined) process.env.BOOF_SHOW_MOCK_TOOL = saved;
    }
  });

  it("lists the mock tool when BOOF_SHOW_MOCK_TOOL is set", async () => {
    const saved = process.env.BOOF_SHOW_MOCK_TOOL;
    process.env.BOOF_SHOW_MOCK_TOOL = "1";
    try {
      await setup(fake(false), [new MockTool(), fake(false)]);
      const out = (await getOp("harnesses.status")!.execute(ctx, {})) as {
        tools: Record<string, { installed: boolean }>;
        anyInstalled: boolean;
      };
      expect(out.tools.mock.installed).toBe(true);
      expect(out.anyInstalled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.BOOF_SHOW_MOCK_TOOL;
      else process.env.BOOF_SHOW_MOCK_TOOL = saved;
    }
  });
});
