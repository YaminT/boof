import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LOCAL_MCP_PRINCIPAL, registry, TaskService, type AnyOperation } from "@boof/heart-server";
import { createBoofMcpServer, exposedOps } from "@boof/heart-server";
import {
  AuthStore,
  authorize,
  LOCAL_PRINCIPAL,
  defaultSettings,
  SettingsStore,
  execCommand,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { cliOps, commandPath, matchOpCommand, opsCommand } from "@boof/facedisk/cli/ops-cli.js";

// REST is proven by packages/heart-server/src/server/contract.test.ts (every operation has a route and a test of
// its shape) and the web UI by packages/heart-server/src/server/op-coverage.test.ts. This file ties MCP and the CLI
// to the same registry.

const json = (o: AnyOperation) => !o.rest.kind || o.rest.kind === "json";

describe("every operation is reachable", () => {
  it("is an MCP tool unless it moves a file", () => {
    const exposed = new Set(exposedOps(registry).map((o) => o.name));
    for (const op of registry) expect(exposed.has(op.name), op.name).toBe(json(op));
  });

  it("is a CLI command", () => {
    expect(registry.filter((o) => o.cli?.hidden).map((o) => o.name)).toEqual([]);
    expect(cliOps()).toHaveLength(registry.length);
    for (const op of registry) {
      expect(matchOpCommand(commandPath(op))?.op, op.name).toBe(op);
    }
  });
});

describe("read-only operations answer on both local surfaces", () => {
  let base: string;
  let root: string;
  let services: TaskService;
  let authStore: AuthStore;
  let taskId: string;
  const open: Client[] = [];

  const makeServices = (r: string) => new TaskService(r, new ToolRegistry([new MockTool()]));
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await opsCommand(
      argv,
      () => root,
      { services: makeServices },
      {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      },
    );
    return { code, out: out.join("\n"), err };
  };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "boof-parity-")));
    root = join(base, "data");
    const repo = join(base, "shop");
    await mkdir(repo, { recursive: true });
    const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
    await g(["init", "-b", "main"]);
    await g(["config", "user.email", "t@e.com"]);
    await g(["config", "user.name", "T"]);
    await writeFile(join(repo, "README.md"), "# shop\n");
    await g(["add", "."]);
    await g(["commit", "-m", "init"]);
    const settings = defaultSettings();
    settings.roles = {
      planner: { tool: "mock", model: "mock-default" },
      developer: { tool: "mock", model: "mock-default" },
      reviewer: { tool: "mock", model: "mock-default" },
    };
    await new SettingsStore(root).save(settings);
    services = makeServices(root);
    authStore = new AuthStore(root);

    const ok = async (argv: string[]) => {
      const r = await cli(argv);
      expect(r.code, argv.join(" ") + " " + r.err.join("\n")).toBe(0);
      return r;
    };
    await ok(["projects", "create", "--working-directory", repo, "--id", "shop"]);
    const goals = [
      {
        id: "a",
        title: "A",
        spec: {
          goal: "Build a",
          stack: "TypeScript",
          rules: { do: ["Test first."], dont: [] },
          tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
        },
      },
    ];
    await writeFile(join(base, "goals.json"), JSON.stringify(goals));
    await ok([
      "plans",
      "create",
      "--project",
      "shop",
      "--id",
      "q4",
      "--title",
      "Q4",
      "--status",
      "active",
      "--goals",
      `@${join(base, "goals.json")}`,
    ]);
    await ok(["plans", "sync", "--project", "shop", "--plan-id", "q4"]);
    await ok(["epics", "create", "--project", "shop", "--title", "E1", "--id", "e1"]);
    taskId = (await services.forProject("shop").list())[0]!.frontmatter.id;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const READ_ONLY = registry.filter((o) => o.mcp.annotations?.readOnlyHint && !o.rest.kind);
  // Only failures the fixture itself causes may be listed here, each with its reason.
  const EXPECTED_FAILURE: Record<string, string> = {
    // The fixture's task never ran, so it has no branch.
    "tasks.diff": "branch_not_found",
  };
  const inputFor = (op: AnyOperation) => {
    const draw: Record<string, unknown> = {
      projectId: "shop",
      planId: "q4",
      taskId,
      epicId: "e1",
      timeoutSeconds: 1,
    };
    const keys = Object.keys((op.input as { shape: object }).shape);
    return Object.fromEntries(Object.entries(draw).filter(([k]) => keys.includes(k)));
  };

  it("has read-only operations to check", () => {
    expect(READ_ONLY.length).toBeGreaterThan(20);
  });

  it.each(READ_ONLY.map((o) => [o.name, o] as const))("%s over the CLI", async (_name, op) => {
    const r = await cli([
      ...commandPath(op),
      "--input",
      JSON.stringify(inputFor(op)),
      "--json",
      "-d",
      root,
    ]);
    const expected = EXPECTED_FAILURE[op.name];
    if (expected) {
      expect(r.code).toBe(2);
      expect(JSON.parse(r.err[0]!).error.code).toBe(expected);
    } else {
      expect(r.code, r.err.join("\n")).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow();
    }
  });

  it.each(READ_ONLY.map((o) => [o.name, o] as const))("%s over MCP", async (_name, op) => {
    const server = createBoofMcpServer({
      root,
      principal: LOCAL_PRINCIPAL,
      services,
      authStore,
    });
    const client = new Client({ name: "parity", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    open.push(client);
    const res = (await client.callTool({ name: op.mcp.name!, arguments: inputFor(op) })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const expected = EXPECTED_FAILURE[op.name];
    if (expected) {
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text.startsWith(expected)).toBe(true);
    } else {
      expect(res.isError, res.content[0]?.text).toBeFalsy();
    }
  });

  describe("the keyless default (local-mcp, no administration tools)", () => {
    it("still reaches every read-only tool it lists", async () => {
      const server = createBoofMcpServer({
        root,
        principal: LOCAL_MCP_PRINCIPAL,
        services,
        authStore,
        adminTools: false,
      });
      const client = new Client({ name: "parity", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      open.push(client);
      const listed = new Set((await client.listTools()).tools.map((t) => t.name));
      const reachable = READ_ONLY.filter((o) => listed.has(o.mcp.name!));
      expect(reachable.length).toBeGreaterThan(10);
      for (const op of reachable) {
        const res = (await client.callTool({ name: op.mcp.name!, arguments: inputFor(op) })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        const expected = EXPECTED_FAILURE[op.name];
        if (expected) expect(res.content[0]!.text.startsWith(expected), op.name).toBe(true);
        else expect(res.isError, `${op.name}: ${res.content[0]?.text}`).toBeFalsy();
      }
    });
  });

  describe("scopes", () => {
    it("a tasks:read client lists no tool it cannot call", async () => {
      const { client: c } = await authStore.create({
        name: "reader",
        scopes: ["tasks:read"],
        trust: "trusted",
      });
      const principal = (await import("@boof/heart-server")).principalFromClient(
        (await authStore.get(c.id))!,
      );
      const server = createBoofMcpServer({ root, principal, services, authStore });
      const client = new Client({ name: "parity", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      open.push(client);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(5);
      for (const name of names) {
        const op = registry.find((o) => o.mcp.name === name)!;
        const allowed = op.scopes.length === 0 || op.scopes.some((s) => authorize(principal, s));
        expect(allowed, name).toBe(true);
        for (const s of ["admin", "auth:admin", "settings:write"] as const) {
          expect(op.scopes, name).not.toContain(s);
        }
      }
    });

    it("the same client is refused the same admin job on the CLI", async () => {
      await authStore.create({ name: "reader", scopes: ["tasks:read"], trust: "trusted" });
      const r = await cli(["--client", "reader", "auth", "clients", "list"]);
      expect(r.code).toBe(3);
    });
  });
});
