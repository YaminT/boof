import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  SettingsStore,
  taskFilePath,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  workingAreaDir,
} from "@boof-runner/shared";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "./service.js";

let root: string;
let app: ReturnType<typeof createApp>;
let service: TaskService;

const req = (path: string, init?: RequestInit) => app.request("http://localhost" + path, init);
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-web-"));
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.tasks.ensureDirs();
  await new SettingsStore(root).save(defaultSettings(root));
  app = createApp({ service });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("task API", () => {
  it("creates, lists, and reads a task", async () => {
    const created = await (
      await req("/api/tasks", json({ title: "Add Auth", prompt: "do it" }))
    ).json();
    expect(created.frontmatter.id).toBe("add-auth");
    expect(created.frontmatter.status).toBe("draft");

    const list = await (await req("/api/tasks")).json();
    expect(list.tasks).toHaveLength(1);

    const got = await (await req("/api/tasks/add-auth")).json();
    expect(got.body.prompt).toBe("do it");
  });

  it("returns 404 for a missing task", async () => {
    const res = await req("/api/tasks/nope");
    expect(res.status).toBe(404);
  });

  it("rejects an invalid update (bad transition)", async () => {
    await (await req("/api/tasks", json({ title: "T", status: "pending" }))).json();
    // pending → done is not a legal transition.
    const res = await req("/api/tasks/t", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(409);
  });

  it("enqueues a draft via status transition and moves the file", async () => {
    await (await req("/api/tasks", json({ title: "T2", status: "draft" }))).json();
    const res = await req("/api/tasks/t2", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "pending", priority: 70 }),
    });
    const updated = await res.json();
    expect(updated.frontmatter.status).toBe("pending");
    expect(updated.frontmatter.priority).toBe(70);
  });

  it("reorder rewrites priorities (first = highest)", async () => {
    await (await req("/api/tasks", json({ title: "A" }))).json();
    await (await req("/api/tasks", json({ title: "B" }))).json();
    const res = await (await req("/api/tasks/reorder", json({ order: ["b", "a"] }))).json();
    const byId = Object.fromEntries(
      res.tasks.map((t: any) => [t.frontmatter.id, t.frontmatter.priority]),
    );
    expect(byId.b).toBeGreaterThan(byId.a);
  });

  it("toggles skip", async () => {
    await (await req("/api/tasks", json({ title: "S" }))).json();
    const res = await (await req("/api/tasks/s/skip", json({ skip: true }))).json();
    expect(res.frontmatter.skip).toBe(true);
  });
});

describe("commands API", () => {
  it("creates a command with derived id and injects into a task", async () => {
    const tpl = await (
      await req("/api/commands", json({ name: "Secure Feature", body: "Be secure." }))
    ).json();
    expect(tpl.id).toBe("secure-feature");

    const task = await (
      await req("/api/tasks", json({ title: "Cmd Task", command: "secure-feature" }))
    ).json();
    expect(task.frontmatter.command).toBe("secure-feature");
    expect(task.body.command).toContain("Be secure.");
  });

  it("rename-and-relink updates referencing tasks", async () => {
    await (await req("/api/commands", json({ name: "Old Name", body: "x" }))).json();
    await (await req("/api/tasks", json({ title: "Ref", command: "old-name" }))).json();
    const renamed = await (
      await req("/api/commands/old-name", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New Name", body: "y" }),
      })
    ).json();
    expect(renamed.id).toBe("new-name");
    const task = await (await req("/api/tasks/ref")).json();
    expect(task.frontmatter.command).toBe("new-name");
  });
});

describe("settings & health API", () => {
  it("reads and patches settings", async () => {
    const res = await req("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner: { enabled: true } }),
    });
    const s = await res.json();
    expect(s.runner.enabled).toBe(true);
  });

  it("accepts, shows and unsets the observer assignment", async () => {
    const put = (body: unknown) =>
      req("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const base = (await (await req("/api/settings")).json()).roles;
    const observer = { tool: "mock", model: "mock-default" };

    expect((await put({ roles: { ...base, observer } })).status).toBe(200);
    expect((await (await req("/api/settings")).json()).roles.observer).toEqual(observer);

    expect((await put({ roles: base })).status).toBe(200);
    const after = await (await req("/api/settings")).json();
    expect(after.roles.observer).toBeUndefined();

    const withReview = await (
      await put({ review: { gate: false, maxFixRounds: 3, maxInlineDiffBytes: 5000 } })
    ).json();
    expect(withReview.review).toEqual({ gate: false, maxFixRounds: 3, maxInlineDiffBytes: 5000 });
  });

  it("reports tool health", async () => {
    const res = await (await req("/api/health")).json();
    expect(res.tools.mock.status).toBe("available");
  });

  it("reports tool models", async () => {
    const res = await (await req("/api/models")).json();
    expect(res.models.mock).toEqual(["mock-default"]);
  });
});

describe("answers loop API", () => {
  it("submits answers and resumes a parked task", async () => {
    // Manually place a parked task in actions/.
    await (await req("/api/tasks", json({ title: "Parked", status: "pending" }))).json();
    await service.tasks.transition("parked", "running");
    await service.tasks.transition("parked", "action", (t) => {
      t.frontmatter.questions = "pending";
      t.body.questions = "1. Which DB?";
    });

    const res = await (
      await req("/api/tasks/parked/answers", json({ answers: "Postgres" }))
    ).json();
    expect(res.frontmatter.status).toBe("pending");
    expect(res.frontmatter.questions).toBe("answered");
    expect(res.body.answers).toBe("Postgres");
  });
});

describe("running task controls", () => {
  it("requests stop and records injected prompts for a running task", async () => {
    await (await req("/api/tasks", json({ title: "Runtime", status: "pending" }))).json();
    await service.tasks.transition("runtime", "running");
    await writeFile(join(workingAreaDir(root, "runtime"), "log.txt"), "");

    const injected = await req("/api/tasks/runtime/inject", json({ prompt: "Focus on tests." }));
    expect(injected.status).toBe(200);
    await expect(readFile(taskPromptInjectionsPath(root, "runtime"), "utf8")).resolves.toContain(
      "Focus on tests.",
    );

    const stopped = await req("/api/tasks/runtime/stop", { method: "POST" });
    expect(stopped.status).toBe(200);
    await expect(readFile(taskStopRequestPath(root, "runtime"), "utf8")).resolves.toContain("T");
  });

  it("rejects runtime controls for non-running tasks", async () => {
    await (await req("/api/tasks", json({ title: "Draft" }))).json();
    expect((await req("/api/tasks/draft/inject", json({ prompt: "x" }))).status).toBe(400);
    expect((await req("/api/tasks/draft/stop", { method: "POST" })).status).toBe(400);
  });
});

describe("attachments API", () => {
  // 1x1 transparent PNG.
  const pngBytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ),
    (ch) => ch.charCodeAt(0),
  );

  const uploadPng = (id: string, name = "shot.png") => {
    const form = new FormData();
    form.append("file", new File([pngBytes], name, { type: "image/png" }));
    return req(`/api/tasks/${id}/attachments`, { method: "POST", body: form });
  };

  it("uploads, lists, serves, and removes an attachment", async () => {
    await (await req("/api/tasks", json({ title: "With files" }))).json();

    const uploaded = await (await uploadPng("with-files")).json();
    expect(uploaded.frontmatter.attachments).toHaveLength(1);
    const att = uploaded.frontmatter.attachments[0];
    expect(att.name).toBe("shot.png");
    expect(att.type).toBe("image/png");
    expect(att.size).toBe(pngBytes.byteLength);

    // The file is served back with its recorded content type.
    const fileRes = await req("/api/tasks/with-files/attachments/shot.png");
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/png");
    expect((await fileRes.arrayBuffer()).byteLength).toBe(pngBytes.byteLength);

    // A second upload of the same name is de-duplicated, not overwritten.
    const second = await (await uploadPng("with-files")).json();
    expect(second.frontmatter.attachments).toHaveLength(2);

    const afterDelete = await (
      await req("/api/tasks/with-files/attachments/shot.png", { method: "DELETE" })
    ).json();
    expect(afterDelete.frontmatter.attachments.map((a: { name: string }) => a.name)).not.toContain(
      "shot.png",
    );
  });

  it("rejects an unsupported attachment type", async () => {
    await (await req("/api/tasks", json({ title: "Bad file" }))).json();
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "evil.exe", { type: "application/octet-stream" }),
    );
    const res = await req("/api/tasks/bad-file/attachments", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });
});

void writeFile;
void taskFilePath;
