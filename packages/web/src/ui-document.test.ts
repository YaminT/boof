import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";
import { isUiPath, relativeBase } from "./ui-document.js";

describe("relativeBase", () => {
  it.each([
    ["/", "./"],
    ["/inbox", "./"],
    ["/index.html", "./"],
    ["/p/boof", "../"],
    ["/p/boof/", "../../"],
    ["/p/boof/tasks", "../../"],
    ["/p/boof/tasks/t1/changes", "../../../../"],
    ["/p/boof/tasks/a%2Fb", "../../../"],
  ])("%s -> %s", (path, base) => expect(relativeBase(path)).toBe(base));
});

describe("isUiPath", () => {
  it.each([
    "/",
    "/index.html",
    "/inbox",
    "/inbox/",
    "/p/boof",
    "/p/boof/",
    "/p/boof/tasks/t1/changes",
    "/p/boof/plans/repo/migration-lock",
    "/p/my%20proj/settings/keys",
  ])("true: %s", (p) => expect(isUiPath(p)).toBe(true));
  it.each([
    "/p",
    "/p/",
    "/p/a/b/c/d/e",
    "/api/v1/projects",
    "/mcp",
    "/healthz",
    "/harness.txt",
    "/llms.txt",
    "/assets/index-x.js",
    "/boof-runner.png",
    "/unknown",
    "/inbox/x",
  ])("false: %s", (p) => expect(isUiPath(p)).toBe(false));
});

describe("UI document and SPA fallback", () => {
  let root: string;
  let ui: string;
  let app: ReturnType<typeof createApp>;
  const get = (path: string, init?: RequestInit) => app.request("http://localhost" + path, init);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "boof-ui-doc-"));
    ui = await mkdtemp(join(tmpdir(), "boof-ui-dist-"));
    await mkdir(join(ui, "assets"));
    await writeFile(
      join(ui, "index.html"),
      '<!doctype html><html><head><title>t</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
    );
    await writeFile(join(ui, "assets", "app.js"), "export {};");
    const service = new TaskService(root, new ToolRegistry([new MockTool()]));
    await new SettingsStore(root).save(defaultSettings());
    app = createApp({ service, peerAddress: () => "127.0.0.1", uiDir: ui });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(ui, { recursive: true, force: true });
  });

  it("serves index.html with a relative base for UI paths", async () => {
    const res = await get("/p/boof/tasks/t1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain('<head><base href="../../../">');
    for (const p of ["/", "/index.html", "/inbox"]) {
      expect(await (await get(p)).text()).toContain('<base href="./">');
    }
    expect(await (await get("/p/boof/tasks/a%2Fb")).text()).toContain('<base href="../../../">');
  });

  it("answers HEAD with an empty body", async () => {
    const res = await get("/p/boof", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("serves assets and 404s everything else", async () => {
    const asset = await get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(await asset.text()).toBe("export {};");
    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/unknown")).status).toBe(404);
    expect((await get("/p/a/b/c/d/e")).status).toBe(404);
    expect((await get("/p/boof", { method: "POST" })).status).toBe(404);
  });

  it("never reflects the request path into the HTML", async () => {
    const res = await get("/p/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(await res.text()).not.toContain("alert(1)");
  });

  it("leaves the other routes and guards alone", async () => {
    expect(((await (await get("/healthz")).json()) as { ok: boolean }).ok).toBe(true);
    expect((await get("/harness.txt")).headers.get("content-type")).toMatch(/text\/plain/);
    const nope = await get("/api/v1/nope");
    expect(nope.status).toBe(404);
    expect(((await nope.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect((await get("/mcp")).headers.get("content-type") ?? "").not.toMatch(/text\/html/);
    expect((await get("/p/boof", { headers: { host: "evil.example" } })).status).toBe(421);
    const cross = await get("/api/v1/projects", { headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe(
      "origin_not_allowed",
    );
    const doc = await get("/p/boof");
    expect(doc.headers.get("x-frame-options")).toBeTruthy();
    expect(doc.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
