import { TEST_LOOPBACK_IS_UI } from "./test-ui-session.js";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootIdentity,
  defaultSettings,
  probeProcess,
  SettingsStore,
  TaskStore,
  execCommand,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { TaskService } from "../api/index.js";
import { createApp } from "./app.js";

const V1 = "/api/v1";
let root: string;
let repo: string;
let service: TaskService;
let app: ReturnType<typeof createApp>;
let store: TaskStore;
const live: number[] = [];

const call = (path: string, init: RequestInit = {}) => app.request("http://localhost" + path, init);
const post = (path: string, body: unknown = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "boof-orphan-")));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-orphan-repo-")));
  await execCommand("git", ["init", "-q"], { launch: { kind: "direct" }, cwd: repo });
  await new SettingsStore(root).save(defaultSettings());
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  store = new TaskStore(service.projects.dir("demo"));
  app = createApp({
    browserSessions: TEST_LOOPBACK_IS_UI,
    service,
    peerAddress: () => "127.0.0.1",
  });
});
afterEach(async () => {
  for (const pid of live.splice(0)) stop(pid);
  for (const d of [root, repo]) await rm(d, { recursive: true, force: true, maxRetries: 10 });
});

/** A failed task whose recorded agent is a real process (or one with a stale identity). */
async function failedTaskWithAgent(identity: "live" | "reused" | "gone") {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: true,
    stdio: "ignore",
  });
  live.push(child.pid!);
  const probe = probeProcess(child.pid!)!;
  const res = await post(`${V1}/projects/demo/tasks`, { title: "Agent", prompt: "p" });
  const id = (await res.json()).frontmatter.id as string;
  await store.transition(id, "pending");
  await store.transition(id, "running");
  await store.modify(id, (t) => {
    t.frontmatter.agentProcess = {
      pgid: child.pid!,
      command: "node",
      bootId: bootIdentity(),
      // A reused pid shows up as another start time. Linux compares start ticks;
      // macOS and Windows compare the start-time string, so both must change.
      startTicks: identity === "reused" ? (probe.startTicks ?? 0) + 5 : (probe.startTicks ?? null),
      startTime: identity === "reused" ? bumpStart(probe.startTime) : probe.startTime,
      recordedAt: new Date().toISOString(),
    };
  });
  await store.transition(id, "failed");
  if (identity === "gone") {
    stop(child.pid!);
    await new Promise((r) => child.on("exit", r));
  }
  return { id, child };
}

/** Last digit + 1, so the string stays the same format and is not equal. */
function bumpStart(start: string | null): string | null {
  if (!start) return start;
  return start.replace(/\d(?!.*\d)/, (digit) => String((Number(digit) + 1) % 10));
}

/** POSIX: the process group. Windows has no groups; the process itself is enough. */
function stop(pid: number) {
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

describe.skipIf(!bootIdentity())("Retry and a recorded agent that is still alive", () => {
  it("refuses to retry, unarchive or queue a task whose recorded agent is still running", async () => {
    const { id } = await failedTaskWithAgent("live");
    for (const attempt of [
      () => post(`${V1}/projects/demo/tasks/${id}/retry`),
      () =>
        call(`${V1}/projects/demo/tasks/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "pending" }),
        }),
    ]) {
      const res = await attempt();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("conflict");
      expect(body.error.message).toMatch(/still running/);
    }
    expect((await store.get(id))!.frontmatter.status).toBe("failed");
  });

  it("refuses to delete a task whose recorded agent is still running (the id could be reused)", async () => {
    const { id, child } = await failedTaskWithAgent("live");
    const res = await call(`${V1}/projects/demo/tasks/${id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/still running/);
    expect(await store.get(id)).toBeTruthy();
    stop(child.pid!);
    await new Promise((r) => child.on("exit", r));
    expect((await call(`${V1}/projects/demo/tasks/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("retries once the agent is gone, and clears the stored identity", async () => {
    const { id, child } = await failedTaskWithAgent("live");
    expect((await post(`${V1}/projects/demo/tasks/${id}/retry`)).status).toBe(409);
    stop(child.pid!);
    await new Promise((r) => child.on("exit", r));
    const res = await post(`${V1}/projects/demo/tasks/${id}/retry`);
    expect(res.status).toBe(200);
    const t = await store.get(id);
    expect(t!.frontmatter.status).toBe("pending");
    expect(t!.frontmatter.agentProcess).toBeUndefined();
  });

  it("a reused pid (another start time) does not block a retry", async () => {
    const { id } = await failedTaskWithAgent("reused");
    expect((await post(`${V1}/projects/demo/tasks/${id}/retry`)).status).toBe(200);
  });

  it("an agent that is already gone does not block a retry", async () => {
    const { id } = await failedTaskWithAgent("gone");
    expect((await post(`${V1}/projects/demo/tasks/${id}/retry`)).status).toBe(200);
  });
});
