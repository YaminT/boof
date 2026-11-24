import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { TaskService } from "./service.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-harnesses-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A mock tool whose install answer the test flips, like installing an agent a moment ago. */
function flipping(state: { installed: boolean }, calls: { n: number }): Tool {
  const mock = new MockTool();
  return Object.assign(Object.create(mock) as Tool, {
    id: "late",
    displayName: "Late agent",
    installed: async () => {
      calls.n++;
      return { installed: state.installed, message: state.installed ? "installed" : "not found" };
    },
  });
}

describe("harnesses refresh", () => {
  it("a Re-check sees an agent installed after the last (cached, seconds old) check", async () => {
    const state = { installed: false };
    const calls = { n: 0 };
    const svc = new TaskService(root, new ToolRegistry([flipping(state, calls)]));
    expect((await svc.harnesses(false)).tools["late"]!.installed).toBe(false);
    state.installed = true;
    // Without refresh the answer may be up to five minutes old.
    expect((await svc.harnesses(false)).tools["late"]!.installed).toBe(false);
    expect(calls.n).toBe(1);
    // Refresh within ten seconds of the last check still re-checks.
    expect((await svc.harnesses(true)).tools["late"]!.installed).toBe(true);
    expect(calls.n).toBe(2);
  });
});
