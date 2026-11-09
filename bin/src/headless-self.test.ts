import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, execCommand, SettingsStore } from "@boof/heart";
import { ToolRegistry, resetMock } from "@boof/runner";

const { transportArgs } = vi.hoisted(() => ({
  transportArgs: [] as { via: string; isSelfUrl: (u: URL) => boolean }[],
}));
vi.mock("@boof/heart-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@boof/heart-server")>();
  return {
    ...original,
    createN8nTransport: (args: { via: string; isSelfUrl: (u: URL) => boolean }) => {
      transportArgs.push(args);
      return (original.createN8nTransport as (a: unknown) => unknown)(args);
    },
  };
});

import { drainQueue, runTask } from "./headless.js";
import { headlessSelfCheck, selfUrlCheck } from "./boot.js";

let dataRoot: string;
let repo: string;
const savedPort = process.env.BOOF_RUNNER_PORT;

beforeEach(async () => {
  transportArgs.length = 0;
  dataRoot = await mkdtemp(join(tmpdir(), "boof-self-data-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-self-repo-")));
  const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(repo, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
  resetMock();
});
afterEach(async () => {
  if (savedPort === undefined) delete process.env.BOOF_RUNNER_PORT;
  else process.env.BOOF_RUNNER_PORT = savedPort;
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const configure = async (): Promise<void> => {
  const store = new SettingsStore(dataRoot);
  await store.save({
    ...defaultSettings(),
    runner: { enabled: true, concurrency: 1 },
    security: { ...defaultSettings().security, allowedHosts: ["boof.example.com:4400"] },
    n8n: {
      baseUrl: "http://n8n.test:5678",
      callbackBaseUrl: "http://localhost:4555/boof",
      defaultTimeoutMs: 600_000,
    },
  } as never);
};

const expectRealSelfCheck = (isSelfUrl: (u: URL) => boolean): void => {
  expect(isSelfUrl(new URL("http://127.0.0.1:4400/x"))).toBe(true); // $BOOF_RUNNER_PORT
  expect(isSelfUrl(new URL("http://[::1]:4400/x"))).toBe(true);
  expect(isSelfUrl(new URL("http://localhost:4555/x"))).toBe(true); // callbackBaseUrl's port
  expect(isSelfUrl(new URL("http://boof.example.com:4400/x"))).toBe(true); // allowedHosts
  expect(isSelfUrl(new URL("http://127.0.0.1:4319/x"))).toBe(false); // not the configured port
  expect(isSelfUrl(new URL("http://127.0.0.1:5678/x"))).toBe(false); // an n8n on loopback
  expect(isSelfUrl(new URL("http://n8n.test:4400/x"))).toBe(false);
};

describe("headless self check wiring", () => {
  it("runTask hands the transport a real self check (not () => false)", async () => {
    process.env.BOOF_RUNNER_PORT = "4400";
    await configure();
    await runTask({
      root: dataRoot,
      prompt: "Build a widget.",
      repo,
      tool: "mock",
      registry: new ToolRegistry(),
      out: () => {},
    });
    expect(transportArgs).toHaveLength(1);
    expect(transportArgs[0]!.via).toBe("runner");
    expectRealSelfCheck(transportArgs[0]!.isSelfUrl);
  });

  it("drainQueue hands the transport a real self check", async () => {
    process.env.BOOF_RUNNER_PORT = "4400";
    await configure();
    await drainQueue({ root: dataRoot, registry: new ToolRegistry(), out: () => {} });
    expect(transportArgs).toHaveLength(1);
    expect(transportArgs[0]!.via).toBe("runner");
    expectRealSelfCheck(transportArgs[0]!.isSelfUrl);
  });
});

describe("headlessSelfCheck", () => {
  it("defaults to port 4319 and ignores a callbackBaseUrl on a remote host", () => {
    delete process.env.BOOF_RUNNER_PORT;
    const check = headlessSelfCheck({
      ...defaultSettings(),
      n8n: {
        baseUrl: "http://n8n.test:5678",
        callbackBaseUrl: "https://boof.test:9443/boof",
        defaultTimeoutMs: 600_000,
      },
    } as never);
    expect(check(new URL("http://127.0.0.1:4319/"))).toBe(true);
    expect(check(new URL("https://boof.test:9443/"))).toBe(false);
    expect(check(new URL("http://127.0.0.1:9443/"))).toBe(false);
  });

  it("selfUrlCheck knows the ports and extra names it was given", () => {
    const check = selfUrlCheck([1234], ["Boof.Example:99"]);
    expect(check(new URL("http://boof.example:1234/"))).toBe(true);
    expect(check(new URL("http://boof.example:99/"))).toBe(false);
    expect(check(new URL("http://127.0.0.1:1234/"))).toBe(true);
  });
});
