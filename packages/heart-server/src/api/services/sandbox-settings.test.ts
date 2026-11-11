import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "@boof/runner";
import { OpError } from "../errors.js";
import { TaskService } from "./service.js";

describe("turning the sandbox on", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function service(
    hooks: {
      assessSandbox?: () => Promise<{ ok: boolean; reason: string }>;
      refreshSandbox?: () => Promise<void>;
    } = {},
  ): Promise<TaskService> {
    const root = await mkdtemp(join(tmpdir(), "boof-sandbox-settings-"));
    roots.push(root);
    return new TaskService(root, new ToolRegistry([]), hooks);
  }

  it("does not save enforce when the check fails", async () => {
    let refreshed = false;
    const svc = await service({
      assessSandbox: async () => ({ ok: false, reason: "landlock abi 3 is below 4" }),
      refreshSandbox: async () => {
        refreshed = true;
      },
    });
    await expect(
      svc.updateSettings({ runner: { sandbox: { mode: "enforce" } } }),
    ).rejects.toMatchObject({
      status: 409,
      code: "sandbox_unavailable",
      message: "landlock abi 3 is below 4",
    });
    expect(refreshed).toBe(false);
    expect((await svc.loadSettings()).runner.sandbox.mode).toBe("off");
  });

  it("does not save enforce when the check throws", async () => {
    const svc = await service({
      assessSandbox: async () => {
        throw new Error("helper crashed");
      },
    });
    await expect(
      svc.updateSettings({ runner: { sandbox: { mode: "enforce" } } }),
    ).rejects.toBeInstanceOf(OpError);
    expect((await svc.loadSettings()).runner.sandbox.mode).toBe("off");
  });

  it("saves a path list and a turn off without the check", async () => {
    const open = await service();
    await open.updateSettings({ runner: { sandbox: { mode: "enforce" } } });
    let calls = 0;
    const guarded = new TaskService(open.root, new ToolRegistry([]), {
      assessSandbox: async () => {
        calls += 1;
        return { ok: false, reason: "no" };
      },
    });
    await guarded.updateSettings({ runner: { sandbox: { readPaths: ["/usr/local"] } } });
    await guarded.updateSettings({ runner: { sandbox: { mode: "off" } } });
    expect(calls).toBe(0);
    const sandbox = (await guarded.loadSettings()).runner.sandbox;
    expect(sandbox.mode).toBe("off");
    expect(sandbox.readPaths).toEqual(["/usr/local"]);
  });

  it("saves enforce when the check passes and then refreshes", async () => {
    let refreshed = false;
    const svc = await service({
      assessSandbox: async () => ({ ok: true, reason: "" }),
      refreshSandbox: async () => {
        refreshed = true;
      },
    });
    await svc.updateSettings({ runner: { sandbox: { mode: "enforce" } } });
    expect(refreshed).toBe(true);
    expect((await svc.loadSettings()).runner.sandbox.mode).toBe("enforce");
  });
});
