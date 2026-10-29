import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  SettingsStore,
  taskFilePath,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  taskSteerRequestPath,
  parseInjected,
  workingAreaDir,
} from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { IdempotencyStore, TaskService, tailLines } from "@boof-runner/api";

let root: string;
let repo: string;
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

describe("GET /healthz", () => {
  it("reports liveness, version, uptime and the runner state", async () => {
    let running = false;
    let now = 1_000_000;
    app = createApp({
      service,
      peerAddress: () => "127.0.0.1",
      version: "9.9.9",
      runnerRunning: () => running,
      now: () => now,
    });
    now += 5_500;
    running = true;
    await new SettingsStore(root).save({
      ...defaultSettings(),
      runner: { ...defaultSettings().runner, enabled: true },
    });
    const res = await req("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: "9.9.9",
      uptimeSeconds: 5,
      runner: { enabled: true, running: true },
    });
  });
});

describe("POST /api/v1/projects", () => {
  it("answers 409 project_exists for a subdirectory of a registered repository", async () => {
    await mkdir(join(repo, "packages", "web"), { recursive: true });
    const res = await req(
      "/api/v1/projects",
      json({ workingDirectory: join(repo, "packages", "web") }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: "project_exists",
      message: expect.stringContaining("repository of project 'default'"),
    });
  });

  it("refuses a linked worktree of a registered repository (same git common dir)", async () => {
    await execCommand(
      "git",
      ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"],
      { cwd: repo },
    );
    const linked = `${repo}-linked`;
    await execCommand("git", ["worktree", "add", "-q", "-b", "wt", linked], { cwd: repo });
    const res = await req("/api/v1/projects", json({ workingDirectory: linked }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: "project_exists",
      message: expect.stringContaining("repository of project 'default'"),
    });
    await rm(linked, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});

describe("task API", () => {
  it("two concurrent creates with one title both succeed with different ids", async () => {
    const svc = service.forProject("default");
    const made = await Promise.all([
      svc.create({ title: "Same title", prompt: "a" }),
      svc.create({ title: "Same title", prompt: "b" }),
    ]);
    expect(new Set(made.map((t) => t.frontmatter.id)).size).toBe(2);
  });

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
    await service.forProject("default").tasks.transition("parked", "running");
    await service.forProject("default").tasks.transition("parked", "action", (t) => {
      t.frontmatter.questions = "pending";
      t.body.questions = "1. Which DB?";
    });

    const res = await (
      await req("/api/tasks/parked/answers", json({ answers: "Postgres" }))
    ).json();
    expect(res.frontmatter.status).toBe("pending");
    expect(res.frontmatter.questions).toBe("answered");
    expect(res.body.answers).toBe("Round 1:\nQuestions:\n1. Which DB?\nAnswers:\nPostgres");
  });

  it("keeps both rounds when a task is answered twice", async () => {
    await (await req("/api/tasks", json({ title: "Twice", status: "pending" }))).json();
    const tasks = service.forProject("default").tasks;
    await tasks.transition("twice", "running");
    const park = async (q: string) => {
      await tasks.transition("twice", "action", (t) => {
        t.frontmatter.questions = "pending";
        t.body.questions = q;
      });
    };
    await park("1. Which DB?");
    await req("/api/tasks/twice/answers", json({ answers: "Postgres" }));
    await tasks.transition("twice", "running");
    await park("1. Managed?");
    const res = await (await req("/api/tasks/twice/answers", json({ answers: "Yes" }))).json();
    expect(res.body.answers).toBe(
      "Round 1:\nQuestions:\n1. Which DB?\nAnswers:\nPostgres\n\n" +
        "Round 2:\nQuestions:\n1. Managed?\nAnswers:\nYes",
    );
  });
});

describe("running task controls", () => {
  it("two updates with the same ETag: exactly one wins", async () => {
    const made = await (await req("/api/tasks", json({ title: "Race" }))).json();
    const put = (title: string) =>
      req("/api/v1/projects/default/tasks/race", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-match": `W/"${made.frontmatter.updated}"`,
        },
        body: JSON.stringify({ title }),
      });
    const [a, b] = await Promise.all([put("A"), put("B")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect((await lost.json()).error.code).toBe("task_modified");
    const won = a.status === 200 ? "A" : "B";
    expect((await service.forProject("default").get("race"))!.frontmatter.title).toBe(won);
  });

  it("stop and inject never recreate the working area of a task that left running", async () => {
    await (await req("/api/tasks", json({ title: "Gone", status: "pending" }))).json();
    const store = service.forProject("default").tasks;
    await store.transition("gone", "running");
    await store.transition("gone", "stopped");
    expect((await req("/api/tasks/gone/stop", { method: "POST" })).status).toBe(400);
    expect((await req("/api/tasks/gone/inject", json({ prompt: "x", mode: "now" }))).status).toBe(
      400,
    );
    const dir = service.projects.dir("default");
    expect(existsSync(workingAreaDir(dir, "gone"))).toBe(false);
    expect(await service.projects.hasRunningTask("default")).toBe(false);
    await store.transition("gone", "pending");
    await store.transition("gone", "running");
    expect(existsSync(taskStopRequestPath(dir, "gone"))).toBe(false);
  });

  it("live-log tail returns the last N lines, running or stored", async () => {
    expect(tailLines("one\ntwo\nthree\nfour\n", 2)).toBe("three\nfour\n");
    expect(tailLines("a\nb\nc", 5)).toBe("a\nb\nc");
    expect(tailLines("", 1)).toBe("");
    await (await req("/api/tasks", json({ title: "Tail", status: "pending" }))).json();
    const store = service.forProject("default").tasks;
    await store.transition("tail", "running");
    const dir = service.projects.dir("default");
    await writeFile(join(workingAreaDir(dir, "tail"), "log.txt"), "one\ntwo\nthree\nfour\n");
    const base = "/api/v1/projects/default/tasks/tail/live-log";
    expect(await (await req(`${base}?tail=2`)).json()).toEqual({
      log: "three\nfour\n",
      running: true,
    });
    expect(await (await req(`${base}?tail=1&format=text`)).text()).toBe("four\n");
    expect((await req(`${base}?tail=0`)).status).toBe(400);
    await store.transition("tail", "stopped");
    await store.modify("tail", (t) => {
      t.body.log = "a\nb\nc";
    });
    expect(await (await req(`${base}?tail=2`)).json()).toEqual({ log: "b\nc", running: false });
  });

  it("requests stop and records injected prompts for a running task", async () => {
    await (await req("/api/tasks", json({ title: "Runtime", status: "pending" }))).json();
    await service.forProject("default").tasks.transition("runtime", "running");
    await writeFile(
      join(workingAreaDir(service.projects.dir("default"), "runtime"), "log.txt"),
      "",
    );

    const injected = await req("/api/tasks/runtime/inject", json({ prompt: "Focus on tests." }));
    expect(injected.status).toBe(200);
    await expect(
      readFile(taskPromptInjectionsPath(service.projects.dir("default"), "runtime"), "utf8"),
    ).resolves.toContain("Focus on tests.");

    const view = await (await req("/api/tasks/runtime")).json();
    expect(view.body.injected).toContain("Focus on tests.");
    expect(view.body.injected).toMatch(/— user\n/);

    const stopped = await req("/api/tasks/runtime/stop", { method: "POST" });
    expect(stopped.status).toBe(200);
    await expect(
      readFile(taskStopRequestPath(service.projects.dir("default"), "runtime"), "utf8"),
    ).resolves.toContain("T");
  });

  it("inject mode now writes a steer request; next-step (the default) does not", async () => {
    await (await req("/api/tasks", json({ title: "Steer", status: "pending" }))).json();
    await service.forProject("default").tasks.transition("steer", "running");
    await writeFile(join(workingAreaDir(service.projects.dir("default"), "steer"), "log.txt"), "");
    const dir = service.projects.dir("default");

    const next = await req("/api/tasks/steer/inject", json({ prompt: "Later." }));
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ ok: true, mode: "next-step", applied: "pending" });
    await expect(readFile(taskSteerRequestPath(dir, "steer"), "utf8")).rejects.toThrow();

    const now = await req("/api/tasks/steer/inject", json({ prompt: "Right now.", mode: "now" }));
    expect(now.status).toBe(200);
    expect(await now.json()).toEqual({ ok: true, mode: "now", applied: "pending" });
    const steer = (await readFile(taskSteerRequestPath(dir, "steer"), "utf8")).trim();
    expect(JSON.parse(steer)).toMatchObject({ text: "Right now." });
    await expect(readFile(taskPromptInjectionsPath(dir, "steer"), "utf8")).resolves.toContain(
      "Right now.",
    );
    const view = await (await req("/api/tasks/steer")).json();
    const entries = parseInjected(view.body.injected);
    expect(entries.map((e) => [e.text, e.mode])).toEqual([
      ["Later.", "next-step"],
      ["Right now.", "now"],
    ]);

    const bad = await req("/api/tasks/steer/inject", json({ prompt: "x", mode: "soon" }));
    expect(bad.status).toBe(400);
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

  it("an upload without an Idempotency-Key never serializes the body", async () => {
    await (await req("/api/tasks", json({ title: "Big" }))).json();
    const spy = vi.spyOn(IdempotencyStore, "fingerprint");
    try {
      const res = await uploadPng("big");
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      // A keyed JSON create still fingerprints (the replay check needs it).
      const keyed = await req("/api/v1/projects/default/tasks", {
        ...json({ title: "Keyed" }),
        headers: { "content-type": "application/json", "Idempotency-Key": "k1" },
      });
      expect(keyed.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

void writeFile;
void taskFilePath;

describe("project registration prunes stale worktrees", () => {
  const stale = async (dir: string, name: string) => {
    const g = (args: string[]) => execCommand("git", args, { cwd: dir, timeoutMs: 15000 });
    await g(["config", "user.email", "t@e.com"]);
    await g(["config", "user.name", "T"]);
    await g(["commit", "--allow-empty", "-q", "-m", "init"]);
    const wt = join(dir, ".boof-runner-worktrees", name);
    await g(["worktree", "add", "-q", wt, "-b", `boof-runner/${name}`]);
    await rm(wt, { recursive: true, force: true });
    const list = async () => (await g(["worktree", "list", "--porcelain"])).stdout;
    expect(await list()).toContain(wt);
    return list;
  };

  it("on create and on unarchive, without a runner restart", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-web-other-")));
    await execCommand("git", ["init", "-q"], { cwd: other });
    const list = await stale(other, "gone");
    const created = await req("/api/v1/projects", json({ workingDirectory: other, id: "other" }));
    expect(created.status).toBe(201);
    expect(await list()).not.toContain("gone");

    await service.archiveProject("other");
    const again = await stale(other, "gone2");
    expect((await req("/api/v1/projects/other/unarchive", { method: "POST" })).status).toBe(200);
    expect(await again()).not.toContain("gone2");
    await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});
