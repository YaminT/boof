import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentEnv } from "../../packages/runner/src/agent-env.js";
import { agentMarkerFor } from "../../packages/runner/src/agent-marker.js";
import { main } from "./boof-runner.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  process.exitCode = 0;
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "boof-containment-"));
  roots.push(value);
  return value;
}

describe("agent containment", () => {
  it.todo("a child with the agent env gets 401 on protected routes and no code for sign-in");
  it.todo("the same child reads /healthz and /harness.txt (public by design)");

  it("main() with the marker for -d <root> exits 3 with R1 and writes nothing", async () => {
    const dataRoot = await root();
    const home = await root();
    const fakeBase = { PATH: process.env.PATH, HOME: home };
    const env = agentEnv(fakeBase, [], agentMarkerFor(dataRoot));
    vi.stubEnv("BOOF_RUNNER_AGENT_OF", env.BOOF_RUNNER_AGENT_OF!);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["-d", dataRoot, "project", "list"]);

    expect(process.exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith(
      "boof-runner: refused. This process was started by a task agent of this boof data root, and task agents get no access to boof. Run boof-runner yourself, outside the agent.",
    );
    await expect(readFile(join(dataRoot, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("main() with the marker for another root (a scratch data root) still works", async () => {
    const spawningRoot = await root();
    const scratchRoot = await root();
    vi.stubEnv("BOOF_RUNNER_AGENT_OF", agentMarkerFor(spawningRoot));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["-d", scratchRoot, "project", "list"]);

    expect(process.exitCode).toBe(0);
    expect(log).toHaveBeenCalled();
  });
});
