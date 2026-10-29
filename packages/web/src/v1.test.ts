import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, BOOF_VERSION, defaultSettings, SettingsStore } from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
let repo: string;
let app: ReturnType<typeof createApp>;

const V1 = "/api/v1";
const call = (path: string, init: RequestInit = {}) => app.request("http://localhost" + path, init);
const send = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-v1-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-v1-repo-")));
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await new SettingsStore(root).save(defaultSettings());
  const service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  app = createApp({ service, peerAddress: () => "127.0.0.1" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

const mkTask = (title: string, extra: object = {}) =>
  call(`${V1}/projects/demo/tasks`, send("POST", { title, prompt: "p", ...extra }));

describe("v1 conventions", () => {
  it("answers 201 for creates and 200 for the same call on the unversioned path", async () => {
    expect((await mkTask("One")).status).toBe(201);
    const old = await call(`/api/projects/demo/tasks`, send("POST", { title: "Two" }));
    expect(old.status).toBe(200);
  });

  it("pages tasks with { items, nextCursor }; the unversioned list keeps { tasks }", async () => {
    for (const t of ["a", "b", "c", "d", "e"]) await mkTask(`Task ${t}`);
    const p1 = await (await call(`${V1}/projects/demo/tasks?limit=2`)).json();
    expect(p1.items).toHaveLength(2);
    expect(typeof p1.nextCursor).toBe("string");
    const p2 = await (
      await call(`${V1}/projects/demo/tasks?limit=2&cursor=${p1.nextCursor}`)
    ).json();
    const p3 = await (
      await call(`${V1}/projects/demo/tasks?limit=2&cursor=${p2.nextCursor}`)
    ).json();
    expect(p3.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items, ...p3.items].map((t) => t.frontmatter.id);
    expect(new Set(ids).size).toBe(5);

    const old = await (await call(`/api/projects/demo/tasks`)).json();
    expect(old.tasks).toHaveLength(5);
    expect(old.items).toBeUndefined();

    const bad = await call(`${V1}/projects/demo/tasks?cursor=@@`);
    expect(bad.status).toBe(400);
    expect((await call(`${V1}/projects/demo/tasks?limit=0`)).status).toBe(400);
  });

  it("filters the task list by status and label", async () => {
    await mkTask("Plain");
    await mkTask("Tagged", { labels: ["x"], status: "pending" });
    const byStatus = await (await call(`${V1}/projects/demo/tasks?status=pending`)).json();
    expect(byStatus.items.map((t: { frontmatter: { id: string } }) => t.frontmatter.id)).toEqual([
      "tagged",
    ]);
    const byLabel = await (await call(`${V1}/projects/demo/tasks?label=x`)).json();
    expect(byLabel.items).toHaveLength(1);
  });

  it("omits body.log unless include=log (v1 only)", async () => {
    await mkTask("Logged");
    const plain = await (await call(`${V1}/projects/demo/tasks/logged`)).json();
    expect("log" in plain.body).toBe(false);
    const full = await (await call(`${V1}/projects/demo/tasks/logged?include=log`)).json();
    expect(full.body.log).toBe("");
    const old = await (await call(`/api/projects/demo/tasks/logged`)).json();
    expect(old.body.log).toBe("");
    expect((await call(`${V1}/projects/demo/tasks/logged?include=nope`)).status).toBe(400);
  });

  it("sends a weak ETag for tasks and refuses a stale If-Match with 409 task_modified", async () => {
    await mkTask("Etag");
    const got = await call(`${V1}/projects/demo/tasks/etag`);
    const etag = got.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);
    const ok = await call(
      `${V1}/projects/demo/tasks/etag`,
      send("PUT", { title: "Etag 2" }, { "If-Match": etag }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).not.toBe(etag);
    const stale = await call(
      `${V1}/projects/demo/tasks/etag`,
      send("PUT", { title: "Etag 3" }, { "If-Match": etag }),
    );
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error.code).toBe("task_modified");
    expect(body.error.details.currentUpdated).toBeTruthy();
    const bad = await call(
      `${V1}/projects/demo/tasks/etag`,
      send("PUT", { title: "x" }, { "If-Match": "garbage" }),
    );
    expect(bad.status).toBe(400);
  });

  it("replays a repeated Idempotency-Key and rejects the key with other input", async () => {
    const key = { "Idempotency-Key": "abc-123" };
    const first = await call(`${V1}/projects/demo/tasks`, send("POST", { title: "Once" }, key));
    const again = await call(`${V1}/projects/demo/tasks`, send("POST", { title: "Once" }, key));
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect((await again.json()).frontmatter.id).toBe("once");
    const list = await (await call(`${V1}/projects/demo/tasks`)).json();
    expect(list.items).toHaveLength(1);
    const other = await call(
      `${V1}/projects/demo/tasks`,
      send("POST", { title: "Different" }, key),
    );
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe("idempotency_conflict");
    expect((await readdir(join(root, "idempotency"))).length).toBe(1);
  });

  it("does not replay a failed request", async () => {
    const key = { "Idempotency-Key": "k-fail" };
    const bad = await call(`${V1}/projects/demo/tasks`, send("POST", { nope: 1 }, key));
    expect(bad.status).toBe(400);
    const good = await call(`${V1}/projects/demo/tasks`, send("POST", { title: "Fine" }, key));
    expect(good.status).toBe(201); // the failure stored nothing, so the key is still free
  });

  it("returns 409 plan_version_conflict with the current version for a stale If-Match", async () => {
    const created = await call(`${V1}/projects/demo/plans`, send("POST", { title: "P", id: "p" }));
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    const ok = await call(
      `${V1}/projects/demo/plans/p`,
      send("PUT", { title: "P2" }, { "If-Match": '"1"' }),
    );
    expect(ok.status).toBe(200);
    const stale = await call(
      `${V1}/projects/demo/plans/p`,
      send("PUT", { title: "P3" }, { "If-Match": '"1"' }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({
      code: "plan_version_conflict",
      details: { currentVersion: 2, expectedVersion: 1 },
    });
  });

  it("serves the OpenAPI document to an authenticated principal only", async () => {
    const res = await call(`${V1}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/projects/{projectId}/plans/{planId}/sync"].post.operationId).toBe(
      "plans.sync",
    );
    const remote = createApp({
      service: new TaskService(root),
      peerAddress: () => "10.1.2.3",
    });
    expect((await remote.request("http://localhost/api/v1/openapi.json")).status).toBe(401);
  });

  it("prefixes server-emitted URLs with X-Forwarded-Prefix (boof behind /boof)", async () => {
    const plain = await (await call(`${V1}/openapi.json`)).json();
    expect(plain.servers).toEqual([{ url: "/api/v1" }]);
    const behind = await (
      await call(`${V1}/openapi.json`, { headers: { "x-forwarded-prefix": "/boof/" } })
    ).json();
    expect(behind.servers).toEqual([{ url: "/boof/api/v1" }]);
    // The legacy route's successor link honours the prefix too.
    const legacy = await call("/api/projects", { headers: { "x-forwarded-prefix": "/boof" } });
    expect(legacy.headers.get("link")).toBe('</boof/api/v1/projects>; rel="successor-version"');
    // Garbage is ignored, never reflected.
    const bad = await (
      await call(`${V1}/openapi.json`, { headers: { "x-forwarded-prefix": "http://x/../y" } })
    ).json();
    expect(bad.servers).toEqual([{ url: "/api/v1" }]);
  });

  it("answers unknown API routes with a JSON 404", async () => {
    const res = await call(`${V1}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("GET /whoami tells any authenticated principal who it is, with no scope", async () => {
    const authStore = new AuthStore(root);
    const { key } = await authStore.create({
      name: "watcher",
      scopes: ["plans:read"],
      trust: "review",
      projects: ["demo"],
    });
    const remote = createApp({
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      authStore,
      peerAddress: () => "10.1.2.3",
    });
    const url = "http://localhost/api/v1/whoami";
    expect((await remote.request(url)).status).toBe(401);
    const res = await remote.request(url, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principal).toMatchObject({
      kind: "client",
      name: "watcher",
      trust: "review",
      scopes: ["plans:read"],
      projects: ["demo"],
    });
    expect(body.server).toEqual({
      version: BOOF_VERSION,
      authMode: "local-trust",
      mcpEnabled: true,
    });
    const local = await (await call(`${V1}/whoami`)).json();
    expect(local.principal).toMatchObject({ kind: "local", scopes: ["admin"], projects: "*" });
  });

  it("keeps BOOF_VERSION equal to the root package.json version", async () => {
    const pkg = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8"),
    );
    expect(BOOF_VERSION).toBe(pkg.version);
  });
});
