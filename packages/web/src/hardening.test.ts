import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "@boof-runner/api";

let root: string;
let repo: string;
let app: ReturnType<typeof createApp>;
let service: TaskService;

const req = (path: string, init?: RequestInit, host?: string) =>
  app.request(
    "http://localhost" + path,
    host ? { ...init, headers: { ...(init?.headers as object), host } } : init,
  );
const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-hard-"));
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-web-repo-")));
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await new SettingsStore(root).save({ ...defaultSettings(), defaultProject: "default" });
  await service.projects.create({ workingDirectory: repo, id: "default" });
  app = createApp({ service, peerAddress: () => "127.0.0.1" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("host guard", () => {
  it("rejects a foreign Host header with 421", async () => {
    const res = await req("/api/tasks", undefined, "evil.example.com");
    expect(res.status).toBe(421);
    expect((await res.json()).error.code).toBe("host_not_allowed");
  });

  it.each(["localhost", "localhost:4319", "127.0.0.1:4319", "[::1]", "[::1]:4319"])(
    "accepts %s",
    async (host) => {
      expect((await req("/api/tasks", undefined, host)).status).toBe(200);
    },
  );

  it("accepts explicitly allowed hosts", async () => {
    app = createApp({ service, peerAddress: () => "127.0.0.1", allowedHosts: ["boof.lan"] });
    expect((await req("/api/tasks", undefined, "boof.lan:80")).status).toBe(200);
  });

  it("sets secure headers", async () => {
    const res = await req("/api/tasks");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends HSTS only when it terminates TLS itself, never with includeSubDomains", async () => {
    expect((await req("/api/tasks")).headers.get("strict-transport-security")).toBeNull();
    app = createApp({ service, peerAddress: () => "127.0.0.1", tls: true });
    expect((await req("/api/tasks")).headers.get("strict-transport-security")).toBe(
      "max-age=15552000",
    );
    expect((await req("/healthz")).headers.get("strict-transport-security")).toBe(
      "max-age=15552000",
    );
    // A proxy terminated TLS: HSTS is its business.
    const viaProxy = await req("/api/tasks", { headers: { "x-forwarded-proto": "https" } });
    expect(viaProxy.headers.get("strict-transport-security")).toBeNull();
  });

  it("the public docs are readable cross-origin; everything else stays same-origin", async () => {
    for (const path of ["/harness.txt", "/harness.md", "/llms.txt"]) {
      const res = await req(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cross-origin-resource-policy"), path).toBe("cross-origin");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    for (const path of ["/api/tasks", "/healthz", "/api/v1/openapi.json"]) {
      expect((await req(path)).headers.get("cross-origin-resource-policy"), path).toBe(
        "same-origin",
      );
    }
  });
});

describe("id validation", () => {
  it("rejects traversal ids and never touches files outside the data root", async () => {
    const victim = join(root, "victim.md");
    await writeFile(victim, "keep me");
    const id = "..%2F..%2Fx";
    const calls: [string, string][] = [
      ["GET", `/api/tasks/${id}`],
      ["PUT", `/api/tasks/${id}`],
      ["DELETE", `/api/tasks/${id}`],
      ["POST", `/api/tasks/${id}/retry`],
      ["POST", `/api/tasks/${id}/archive`],
    ];
    for (const [method, path] of calls) {
      const res = await req(path, method === "PUT" ? send("PUT", { title: "x" }) : { method });
      expect(res.status, `${method} ${path}`).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_input");
    }
    const cmd = await req(`/api/commands/${id}`, { method: "DELETE" });
    expect(cmd.status).toBe(400);
    await expect(readFile(victim, "utf8")).resolves.toBe("keep me");
  });
});

describe("body validation", () => {
  it("returns 413 for oversized JSON bodies", async () => {
    const res = await req(
      "/api/tasks",
      send("POST", { title: "t", prompt: "a".repeat(1_100_000) }),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
  });

  it("rejects unknown body keys with invalid_input", async () => {
    const res = await req("/api/tasks", send("POST", { title: "t", bogus: 1 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it("rejects malformed JSON", async () => {
    const res = await req("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("rejects unknown settings keys", async () => {
    const res = await req("/api/settings", send("PUT", { selectedSubdirectory: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("accepts a valid settings patch", async () => {
    const res = await req("/api/settings", send("PUT", { runner: { enabled: false } }));
    expect(res.status).toBe(200);
  });
});

describe("status transitions and error shape", () => {
  it("rejects a user-requested move to running with 409", async () => {
    await req("/api/tasks", send("POST", { title: "T", status: "pending" }));
    const res = await req("/api/tasks/t", send("PUT", { status: "running" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_transition");
    expect(body.error.message).toContain("pending");
  });

  it("uses the { error: { code, message } } envelope for not found", async () => {
    const res = await req("/api/tasks/missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });
});
