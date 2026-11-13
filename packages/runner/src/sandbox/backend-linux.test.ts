import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boofSandboxHelperPath,
  planLinuxSandbox,
  resolveBoofSandboxHelper,
} from "./backend-linux.js";

const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boof-helper-path-"));
  roots.push(dir);
  return dir;
}

describe("boof-sandbox helper path", () => {
  it("uses an explicit path and does not search PATH", async () => {
    const root = await tempDir();
    const decoyDir = join(root, "bin");
    await mkdir(decoyDir);
    const decoy = join(decoyDir, "boof-sandbox");
    await writeFile(decoy, elf);
    await chmod(decoy, 0o755);
    const moduleFile = join(root, "app", "main.js");
    await mkdir(join(root, "app"));
    expect(resolveBoofSandboxHelper(moduleFile, { BOOF_SANDBOX_HELPER: "/opt/helper" })).toBe(
      "/opt/helper",
    );
    expect(resolveBoofSandboxHelper(moduleFile, { PATH: decoyDir })).toBe(
      join(root, "app", "boof-sandbox"),
    );
    expect(boofSandboxHelperPath({ PATH: decoyDir, BOOF_SANDBOX_HELPER: "" })).not.toBe(decoy);
  });

  it("prefers the binary beside the bundle over the checkout dist", async () => {
    const root = await tempDir();
    const beside = join(root, "resources", "app", "boof-sandbox");
    const dist = join(root, "packages", "sandbox-linux", "dist", "boof-sandbox");
    await mkdir(join(root, "resources", "app"), { recursive: true });
    await mkdir(join(root, "packages", "sandbox-linux", "dist"), { recursive: true });
    await writeFile(beside, elf);
    await writeFile(dist, elf);
    expect(resolveBoofSandboxHelper(join(root, "resources", "app", "main.js"), {})).toBe(beside);
  });

  it("uses packages/sandbox-linux/dist when nothing sits beside the bundle", async () => {
    const root = await tempDir();
    const moduleFile = join(root, "bin", "dist", "boof-runner.js");
    const dist = join(root, "packages", "sandbox-linux", "dist", "boof-sandbox");
    await mkdir(join(root, "bin", "dist"), { recursive: true });
    await mkdir(join(root, "packages", "sandbox-linux", "dist"), { recursive: true });
    await writeFile(dist, elf);
    expect(resolveBoofSandboxHelper(moduleFile, {})).toBe(dist);
  });
});

describe("sandbox process-cap knobs", () => {
  const policy = (env: Record<string, string>) => ({
    version: 1 as const,
    readExec: [],
    readWrite: [],
    denyTcpPorts: [],
    env,
  });

  it("takes the knobs from the server environment only, never from an agent or step env", async () => {
    const root = await tempDir();
    const helper = join(root, "boof-sandbox");
    await writeFile(helper, elf);
    const saved = { ...process.env };
    try {
      delete process.env.BOOF_SANDBOX_NPROC_FLOOR;
      process.env.BOOF_SANDBOX_NPROC_HEADROOM = "5000";
      const plan = planLinuxSandbox(
        { kind: "sandbox", helper, policy: policy({ BOOF_SANDBOX_NPROC_FLOOR: "999999" }) },
        "true",
        [],
        { BOOF_SANDBOX_NPROC_HEADROOM: "999999", BOOF_SANDBOX_NPROC_FLOOR: "999999" },
      );
      expect(plan.env.BOOF_SANDBOX_NPROC_FLOOR).toBeUndefined();
      expect(plan.env.BOOF_SANDBOX_NPROC_HEADROOM).toBe("5000");
    } finally {
      for (const key of ["BOOF_SANDBOX_NPROC_FLOOR", "BOOF_SANDBOX_NPROC_HEADROOM"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
