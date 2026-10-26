import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { registry, TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-contract-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("REST routes match the registry", () => {
  it("serves every operation at its method and path under /api/v1 and the unversioned prefix", async () => {
    const app = createApp({
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      peerAddress: () => "127.0.0.1",
    });
    for (const prefix of ["/api/v1", "/api"]) {
      for (const op of registry) {
        const path = prefix + op.rest.path.replace(/\{(\w+)\}/g, "x");
        const res = await app.request("http://localhost" + path, {
          method: op.rest.method,
          headers: { "content-type": "application/json" },
        });
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        // Whatever the handler says, the router must have found the route.
        expect(body.error?.message ?? "", `${op.rest.method} ${path}`).not.toMatch(
          /^No such route/,
        );
      }
    }
  });

  it("answers a route that is not in the registry with 404 not_found", async () => {
    const app = createApp({
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      peerAddress: () => "127.0.0.1",
    });
    const res = await app.request("http://localhost/api/v1/nothing-here");
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/^No such route/);
  });
});
