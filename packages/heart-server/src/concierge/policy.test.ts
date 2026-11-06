import { describe, expect, it } from "vitest";
import { LOCAL_PRINCIPAL, type Principal, type Scope } from "@boof/heart";
import { registry } from "../api/index.js";
import {
  CONCIERGE_SCOPES,
  CONCIERGE_TOOLS,
  conciergeAllowedTools,
  assertConciergeIdAvailable,
  conciergeOps,
  conciergePrincipal,
} from "./policy.js";

const projectId = "shop";

const principal = (
  id: string,
  scopes: Scope[],
  projects: "*" | string[] = "*",
  trust: Principal["trust"] = "trusted",
): Principal => ({
  kind: "client",
  id,
  name: id,
  scopes: new Set(scopes),
  projects: projects === "*" ? "*" : new Set(projects),
  trust,
});

describe("concierge MCP policy", () => {
  it("contains only exposed registry operations with an allowed scope", () => {
    const ops = conciergeOps(registry);
    const byName = new Map(registry.map((op) => [op.name, op]));

    expect(ops.map((op) => op.name)).toEqual(
      registry.filter((op) => Object.hasOwn(CONCIERGE_TOOLS, op.name)).map((op) => op.name),
    );
    expect(new Set(Object.keys(CONCIERGE_TOOLS))).toEqual(new Set(ops.map((op) => op.name)));
    for (const op of ops) {
      expect(byName.has(op.name)).toBe(true);
      expect(op.mcp.expose).toBe(true);
      expect(op.scopes.some((scope) => CONCIERGE_SCOPES.includes(scope))).toBe(true);
      if (op.mcp.annotations?.destructiveHint) {
        expect(CONCIERGE_TOOLS[op.name]).toBe("confirm");
      }
    }
  });

  it("excludes operations that leave the pinned, safe tool policy", () => {
    for (const name of [
      "tasks.diff",
      "plans.import",
      "tasks.wait",
      "plans.wait",
      "tasks.stop",
      "tasks.inject",
      "tasks.answers",
      "tasks.retry",
      "tasks.skip",
      "plans.sync",
      "projects.create",
      "projects.update",
      "settings.update",
      "commands.create",
      "attachments.upload",
    ]) {
      expect(CONCIERGE_TOOLS[name]).toBeUndefined();
    }
  });

  it.each([
    ["local admin", LOCAL_PRINCIPAL, [...CONCIERGE_SCOPES], [projectId]],
    [
      "review tasks reader",
      principal("reader", ["tasks:read"], "*", "review"),
      ["tasks:read"],
      [projectId],
    ],
    [
      "other-project key",
      principal("other", ["projects:read", "plans:read", "tasks:read"], ["elsewhere"]),
      ["projects:read", "plans:read", "tasks:read"],
      [],
    ],
    [
      "control and settings key",
      principal("restricted", ["tasks:control", "settings:write"]),
      [],
      [projectId],
    ],
  ])("derives a narrow principal for %s", (_label, user, expectedScopes, expectedProjects) => {
    const derived = conciergePrincipal(user as Principal, projectId);
    expect(derived).toMatchObject({
      id: `concierge-${(user as Principal).id}`,
      name: `Assistant for ${(user as Principal).name}`,
      kind: "client",
      clientKind: "mcp",
      trust: "review",
      alwaysReview: true,
    });
    expect([...derived.scopes]).toEqual(expectedScopes);
    expect([...derived.projects]).toEqual(expectedProjects);
    expect(derived.operator).toBeUndefined();
    for (const forbidden of [
      "admin",
      "auth:admin",
      "settings:read",
      "settings:write",
      "runner:control",
      "tasks:control",
      "projects:write",
    ] satisfies Scope[]) {
      expect(derived.scopes.has(forbidden)).toBe(false);
    }
  });

  it("offers no writes or confirmations to a read-only principal", () => {
    const reader = principal("reader", ["tasks:read"], [projectId], "review");
    const ops = conciergeOps(registry);
    const names = conciergeAllowedTools(ops, reader);
    const byTool = new Map(ops.map((op) => [`mcp__boof__${op.mcp.name}`, op.name]));
    expect(names.every((name) => CONCIERGE_TOOLS[byTool.get(name)!] === "read")).toBe(true);
    expect(names).not.toContain("mcp__boof__boof_delete_task");
    expect(names.every((name) => name.startsWith("mcp__boof__"))).toBe(true);
  });

  it("refuses a legacy stored client that collides with the concierge principal id", async () => {
    const { mkdtemp, rm, readFile, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AuthStore } = await import("@boof/heart");
    const root = await mkdtemp(join(tmpdir(), "boof-concierge-collision-"));
    try {
      const store = new AuthStore(root);
      const { client } = await store.create({ name: "old", scopes: ["tasks:read"] });
      const path = join(root, "auth", "clients.json");
      const raw = JSON.parse(await readFile(path, "utf8"));
      raw.clients[0].id = `concierge-${client.id}`;
      await writeFile(path, JSON.stringify(raw));
      const legacy = new AuthStore(root);
      await expect(
        assertConciergeIdAvailable(
          {
            kind: "client",
            id: client.id,
            name: client.name,
            scopes: new Set(client.scopes),
            projects: "*",
            trust: "review",
          },
          legacy,
        ),
      ).rejects.toThrow(/reserved id concierge-/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
