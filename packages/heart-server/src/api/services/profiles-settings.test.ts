import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockTool, ToolRegistry } from "@boof/runner";
import type { OrchestrationProfile } from "@boof/heart";
import { TaskService } from "./service.js";

const dev = { tool: "mock", model: "mock-default" };
const profile = (id: string, over: Partial<OrchestrationProfile["roles"]> = {}) => ({
  id,
  name: id,
  roles: { planner: null, developer: dev, observer: null, reviewer: null, ...over },
});

describe("profiles in settings.update and project updates", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function service(): Promise<TaskService> {
    const root = await mkdtemp(join(tmpdir(), "boof-profiles-"));
    dirs.push(root);
    return new TaskService(root, new ToolRegistry([new MockTool()]));
  }

  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "boof-profiles-wd-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    return dir;
  }

  it("stores profiles and an active profile", async () => {
    const svc = await service();
    const next = await svc.updateSettings({
      profiles: [profile("solo"), profile("full", { planner: dev, reviewer: dev })],
      activeProfile: "solo",
    });
    expect(next.profiles?.map((p) => p.id)).toEqual(["solo", "full"]);
    expect(next.activeProfile).toBe("solo");
    expect((await svc.loadSettings()).schemaVersion).toBe(3);
  });

  it("refuses an unknown tool id", async () => {
    const svc = await service();
    await expect(
      svc.updateSettings({ profiles: [profile("x", { developer: { tool: "nope", model: "m" } })] }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    expect((await svc.loadSettings()).profiles).toBeUndefined();
  });

  it("refuses an active profile that does not exist and duplicate ids", async () => {
    const svc = await service();
    await expect(svc.updateSettings({ activeProfile: "ghost" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
    });
    await expect(
      svc.updateSettings({ profiles: [profile("a"), profile("a")] }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
  });

  it("null clears the active profile", async () => {
    const svc = await service();
    await svc.updateSettings({ profiles: [profile("a")], activeProfile: "a" });
    const next = await svc.updateSettings({ activeProfile: null });
    expect(next.activeProfile).toBeUndefined();
    expect(next.profiles).toHaveLength(1);
  });

  it("refuses deleting a profile a project uses, and names the project", async () => {
    const svc = await service();
    await svc.updateSettings({ profiles: [profile("a"), profile("b")] });
    await svc.createProject({ workingDirectory: await repo(), id: "alpha" });
    await svc.updateProject("alpha", { profile: "a" });
    await expect(svc.updateSettings({ profiles: [profile("b")] })).rejects.toMatchObject({
      status: 409,
      code: "profile_in_use",
      message: expect.stringContaining("alpha"),
    });
    expect((await svc.loadSettings()).profiles).toHaveLength(2);
    // Deleting an unused one works, and so does deleting after the project lets go.
    await svc.updateSettings({ profiles: [profile("a")] });
    await svc.updateProject("alpha", { profile: null });
    await svc.updateSettings({ profiles: [] });
    expect((await svc.loadSettings()).profiles).toEqual([]);
  });

  it("refuses a project profile that is not defined", async () => {
    const svc = await service();
    await svc.createProject({ workingDirectory: await repo(), id: "alpha" });
    await expect(svc.updateProject("alpha", { profile: "ghost" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
    });
  });
});
