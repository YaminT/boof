import { execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  defaultSettings,
  SecuritySettingsSchema,
  SettingsStore,
  execCommand,
} from "@boof/heart";
import { TaskService } from "../api/index.js";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";

let base: string;
let root: string;
let receiver: Server;
let delivered: string[];
let children: ChildProcess[];

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const childFile = fileURLToPath(new URL("../../test-support/serve-child.mts", import.meta.url));

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-hooks-proc-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  delivered = [];
  children = [];
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      delivered.push(JSON.parse(body).task);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
});

afterEach(async () => {
  for (const c of children) c.kill("SIGKILL");
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

const startChild = (): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", childFile, root], {
      cwd: repoRoot,
    });
    children.push(child);
    let out = "";
    child.stdout?.on("data", (c) => {
      out += c;
      if (out.includes("\n")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`child exited ${code}: ${out}`)));
  });

const event = (task: string) => ({
  type: "task.status" as const,
  project: "a",
  task,
  from: "pending",
  to: "running",
  by: "runner",
});

describe("one webhook dispatcher per data root", () => {
  it("two servers deliver each event once, and the other takes over when the holder dies", async () => {
    const repo = join(base, "a");
    await mkdir(repo);
    await execCommand("git", ["init", "-q"], { cwd: repo });
    const settings = new SettingsStore(root);
    const current = defaultSettings();
    await settings.save({
      ...current,
      security: SecuritySettingsSchema.parse({
        ...current.security,
        allowedPrivateWebhookHosts: ["127.0.0.1"],
      }),
    });
    const service = new TaskService(root, new ToolRegistry([new MockTool()]));
    await service.projects.create({ workingDirectory: repo, id: "a" });
    const app = createApp({ service, peerAddress: () => "127.0.0.1" });
    const made = await app.request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/in`,
      }),
    });
    expect(made.status).toBeLessThan(300);

    await Promise.all([startChild(), startChild()]);
    const lockFile = join(root, "webhooks", ".dispatcher.lock");
    // The holder has started delivering once it wrote the hook's cursor.
    await until(async () =>
      readFile(join(root, "webhooks", "state.json"), "utf8").then(
        (t) => Object.keys(JSON.parse(t)).length > 0,
        () => false,
      ),
    );

    for (const t of ["e1", "e2", "e3", "e4", "e5"]) {
      await appendEvent(join(root, "projects", "a"), event(t));
    }
    await until(() => delivered.length >= 5);
    await new Promise((r) => setTimeout(r, 1500)); // a second dispatcher would have posted by now
    expect([...delivered].sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);

    // Kill the holder without a release: the other server takes over delivery.
    const holderPid = Number((await readFile(lockFile, "utf8")).trim().split(" ")[0]);
    process.kill(holderPid, "SIGKILL");
    for (const t of ["e6", "e7", "e8"]) {
      await appendEvent(join(root, "projects", "a"), event(t));
    }
    await until(() => delivered.length >= 8);
    await new Promise((r) => setTimeout(r, 1500));
    expect([...delivered].sort()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]);
  }, 90_000);
});
