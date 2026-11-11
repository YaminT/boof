import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(new URL(import.meta.url).pathname);
const dist = join(here, "dist");
const helper = join(dist, "boof-sandbox");
const testHelper = join(dist, "boof-sandbox-test");
const probe = join(dist, "probe");
const filterCheck = join(dist, "filter-check");

const roots: string[] = [];

function compile(source: string, out: string, flags: string[] = []): void {
  const result = spawnSync(
    "cc",
    ["-O2", "-Wall", "-Wextra", "-Werror", ...flags, "-o", out, source],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `cc ${source} failed`);
  }
}

function existing(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path)).map((path) => realpathSync(path));
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(
  policy: string,
  args: string[],
  timeoutMs = 8000,
  env: NodeJS.ProcessEnv = process.env,
  executable = helper,
): Promise<RunResult> {
  const dir = join(tmpdir(), `boof-sandbox-pol-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "policy.json");
  writeFileSync(path, policy);
  const fd = openSync(path, "r");
  const started = performance.now();
  const child = spawn(executable, ["--policy-fd", "3", "--", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe", fd],
  });
  closeSync(fd);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr, ms: performance.now() - started });
    });
  });
}

function policy(readExec: string[], readWrite: string[], denyTcpPorts: number[]): string {
  return JSON.stringify({ version: 1, readExec, readWrite, denyTcpPorts });
}

function expectHelperError(result: RunResult, text: string): void {
  expect(result.code).toBe(126);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("");
  const lines = result.stderr.split("\n");
  expect(lines).toEqual([expect.stringContaining("boof-sandbox:"), ""]);
  expect(result.stderr.startsWith("boof-sandbox: ")).toBe(true);
  expect(result.stderr).toContain(text);
}

async function listen(host: string, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only: host.includes(":") }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

describe.skipIf(process.platform !== "linux")("boof-sandbox", () => {
  let abi = 0;
  let readExec: string[] = [];
  let work = "";
  let data = "";
  let tmpFile = "";
  let boofV4: { server: Server; port: number } | null = null;
  let boofV6: { server: Server; port: number } | null = null;

  beforeAll(() => {
    mkdirSync(dist, { recursive: true });
    const built = spawnSync(process.execPath, [join(here, "build.mjs")], { encoding: "utf8" });
    if (built.status !== 0) {
      throw new Error(built.stderr || built.stdout || "build.mjs failed");
    }
    if (!existsSync(helper)) throw new Error("build.mjs produced no helper on Linux");
    const asanFlags =
      process.env.BOOF_SANDBOX_ASAN === "1"
        ? ["-fsanitize=address", "-fno-omit-frame-pointer"]
        : [];
    if (asanFlags.length > 0) compile(join(here, "boof-sandbox.c"), helper, asanFlags);
    compile(join(here, "probe.c"), probe);
    compile(join(here, "filter-check.c"), filterCheck);
    compile(join(here, "boof-sandbox.c"), testHelper, ["-DBOOF_SANDBOX_TEST", ...asanFlags]);
    const abiRun = spawnSync(helper, ["--abi"], { encoding: "utf8" });
    expect(abiRun.status).toBe(0);
    expect(abiRun.stderr).toBe("");
    abi = Number(abiRun.stdout.trim());
    expect(abi).toBeGreaterThanOrEqual(4);
    readExec = existing(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/sys", dist]);
  }, 60_000);

  afterAll(async () => {
    boofV4?.server.close();
    boofV6?.server.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tree(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "boof-sandbox-"));
    roots.push(root);
    data = join(root, "data");
    work = join(root, "work");
    await mkdir(join(data, "auth"), { recursive: true });
    await mkdir(join(data, "n8n"), { recursive: true });
    mkdirSync(work);
    await writeFile(join(data, "settings.json"), '{"secret":true}\n');
    await writeFile(join(data, "auth", "token"), "token\n");
    await writeFile(join(data, "n8n", "secrets.json"), '{"k":1}\n');
    await writeFile(join(work, "visible.txt"), "visible\n");
    tmpFile = join(tmpdir(), `boof-sandbox-tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmpFile, "tmp-secret\n");
    roots.push(tmpFile);
  }

  async function boofPort(): Promise<number> {
    if (!boofV4 || !boofV6) {
      boofV4 = await listen("127.0.0.1");
      boofV6 = await listen("::1", boofV4.port);
    }
    return boofV4.port;
  }

  function basePolicy(deny: number[]): string {
    return policy(readExec, [work], deny);
  }

  it("prints the Landlock ABI from --abi", () => {
    const result = spawnSync(helper, ["--abi"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(abi));
    expect(result.stderr).toBe("");
  });

  it("executes a nested tool binary through a symlinked bin and denies a binary outside its install tree", async () => {
    await tree();
    const install = await mkdtemp(join(tmpdir(), "boof-tool-install-"));
    roots.push(install);
    const nestedBin = join(install, "vendor", "aarch64-unknown-linux-musl", "bin");
    const linkedBin = join(install, "bin");
    const outside = join(dirname(install), `outside-tool-${process.pid}`);
    roots.push(outside);
    await mkdir(nestedBin, { recursive: true });
    await mkdir(linkedBin, { recursive: true });
    writeFileSync(
      join(install, "package.json"),
      '{"name":"fake-codex","bin":{"codex":"bin/codex"}}\n',
    );
    writeFileSync(join(nestedBin, "codex"), "#!/bin/sh\nprintf 'nested tool ran\\n'\n");
    writeFileSync(outside, "#!/bin/sh\nprintf 'outside tool ran\\n'\n");
    chmodSync(join(nestedBin, "codex"), 0o755);
    chmodSync(outside, 0o755);
    await symlink(join(nestedBin, "codex"), join(linkedBin, "codex"));

    const text = policy([...readExec, install], [work], []);
    const allowed = await run(text, [join(linkedBin, "codex")]);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe("nested tool ran\n");
    const denied = await run(text, [outside]);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("Permission denied");
  });

  it("rejects --self-test instead of running one", async () => {
    const result = spawnSync(helper, ["--self-test"], { encoding: "utf8" });
    expect(result.status).toBe(126);
    expect(result.stderr).toBe("boof-sandbox: bad arguments\n");
  });

  it("A1 denies reads of settings.json, auth/ and n8n/secrets.json", async () => {
    await tree();
    const text = basePolicy([]);
    const visible = await run(text, [probe, "read", join(work, "visible.txt")]);
    expect(visible.code).toBe(0);
    expect(visible.stdout).toBe("read ok\n");
    const settings = await run(text, [probe, "read", join(data, "settings.json")]);
    expect(settings.stdout).toBe("read EACCES\n");
    const auth = await run(text, [probe, "readdir", join(data, "auth")]);
    expect(auth.stdout).toBe("readdir EACCES\n");
    const secrets = await run(text, [probe, "read", join(data, "n8n", "secrets.json")]);
    expect(secrets.stdout).toBe("read EACCES\n");
  });

  it("A2 denies creating or overwriting a file in the data root", async () => {
    await tree();
    const text = basePolicy([]);
    const allowed = await run(text, [probe, "write", join(work, "created.txt")]);
    expect(allowed.stdout).toBe("write ok\n");
    const created = await run(text, [probe, "write", join(data, "pwned")]);
    expect(created.stdout).toBe("write EACCES\n");
    expect(existsSync(join(data, "pwned"))).toBe(false);
    const overwritten = await run(text, [probe, "overwrite", join(data, "settings.json")]);
    expect(overwritten.stdout).toBe("overwrite EACCES\n");
  });

  it("refuses a rule path that is a symlink before executing the child", async () => {
    await tree();
    const link = join(work, "escape");
    await symlink(data, link);
    const result = await run(policy(readExec, [link], []), [
      probe,
      "read",
      join(data, "settings.json"),
    ]);
    expectHelperError(result, "cannot open path");
    expect(result.stdout).toBe("");
  });

  it("keeps a shared git objects directory read-only", async () => {
    await tree();
    const objects = join(data, "objects");
    await mkdir(objects);
    await writeFile(join(objects, "existing-object"), "owner object\n");
    const text = policy([...readExec, objects], [work], []);
    const rewrite = await run(text, [probe, "overwrite", join(objects, "existing-object")]);
    const removeAttempt = await run(text, [probe, "write", join(objects, "agent-object")]);
    expect(rewrite.stdout).toBe("overwrite EACCES\n");
    expect(removeAttempt.stdout).toBe("write EACCES\n");
    expect(readFileSync(join(objects, "existing-object"), "utf8")).toBe("owner object\n");
  });

  it("bounds listen-without-bind port guessing by the helper fd limit", async () => {
    await tree();
    const result = await run(basePolicy([]), [probe, "listen-loop"], 12000);
    expect(result.code).toBe(0);
    const match = /^listen-loop (\d+) EMFILE\n$/.exec(result.stdout);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(4096);
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  it("A3 denies connect to the boof port on 127.0.0.1 and ::1", async () => {
    await tree();
    const port = await boofPort();
    const text = basePolicy([port]);
    const v4 = await run(text, [probe, "connect4", String(port)]);
    const v6 = await run(text, [probe, "connect6", String(port)]);
    expect(v4.stdout).toBe("connect EACCES\n");
    expect(v6.stdout).toBe("connect EACCES\n");
  });

  it("A4 denies binding the boof port after the listener closed", async () => {
    await tree();
    const held = await listen("127.0.0.1");
    const port = held.port;
    await new Promise<void>((resolve, reject) =>
      held.server.close((err) => (err ? reject(err) : resolve())),
    );
    const text = basePolicy([port]);
    const bound = await run(text, [probe, "bind4", String(port)]);
    expect(bound.stdout).toBe("bind EACCES\n");
    const bound6 = await run(text, [probe, "bind6", String(port)]);
    expect(bound6.stdout).toBe("bind EACCES\n");
  });

  it("A19 allows bind(:0) and listen on IPv4 and IPv6 without granting connect(:0)", async () => {
    await tree();
    const text = basePolicy([1]);
    for (const mode of ["bind0v4", "bind0v6"]) {
      const bound = await run(text, [probe, mode]);
      expect(bound.code).toBe(0);
      expect(bound.stdout).toMatch(new RegExp(`^${mode} ok ([1-9][0-9]*) listen ok\\n$`));
      const port = Number(bound.stdout.match(/ ok ([1-9][0-9]*) listen/)?.[1]);
      expect(port).not.toBe(1);
    }
    const connected4 = await run(basePolicy([]), [probe, "connect4", "0"]);
    const connected6 = await run(basePolicy([]), [probe, "connect6", "0"]);
    expect(connected4.stdout).toBe("connect EACCES\n");
    expect(connected6.stdout).toBe("connect EACCES\n");
  });

  it("A20 fails closed when a denied port is inside the configured ephemeral range", async () => {
    await tree();
    const [firstText, lastText] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim()
      .split(/\s+/);
    const first = Number(firstText);
    const last = Number(lastText);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThanOrEqual(first);
    const denied = first;
    const rangeFile = join(work, "ephemeral-range");
    writeFileSync(rangeFile, `${denied} ${last}\n`);
    const env = { ...process.env, BOOF_SANDBOX_PORT_RANGE_FILE: rangeFile };
    const result = await run(basePolicy([denied]), [probe, "bind0v4"], 8000, env, testHelper);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("bind0v4 EACCES\n");
  });

  it("A3 denies MPTCP, TCP Fast Open and AF_SMC reaches of the boof port", async () => {
    await tree();
    const port = await boofPort();
    let hits = 0;
    const onConnection = () => {
      hits += 1;
    };
    boofV4?.server.on("connection", onConnection);
    boofV6?.server.on("connection", onConnection);
    try {
      const result = await run(basePolicy([port]), [probe, "a3-bypass", String(port)]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        [
          "tcp4 EACCES",
          "mptcp4 EPERM",
          "mptcp6 EPERM",
          "tfo4 EPERM",
          "tfo6 EPERM",
          "tfomsg EPERM",
          "tfommsg EPERM",
          "smc EPERM",
          "sctp EPERM",
          "alg EPERM",
          "",
        ].join("\n"),
      );
      expect(hits).toBe(0);
    } finally {
      boofV4?.server.off("connection", onConnection);
      boofV6?.server.off("connection", onConnection);
    }
  });

  it("A4 denies an MPTCP bind of the boof port after the listener closed", async () => {
    await tree();
    const held4 = await listen("127.0.0.1");
    const held6 = await listen("::1", held4.port);
    const port = held4.port;
    await new Promise<void>((resolve, reject) =>
      held4.server.close((err) => (err ? reject(err) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      held6.server.close((err) => (err ? reject(err) : resolve())),
    );
    const result = await run(basePolicy([port]), [probe, "a4-mptcp", String(port)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mptcp-bind4 EPERM\nmptcp-bind6 EPERM\n");
  });

  it("allows TCP, UDP, ICMP and route netlink, and denies other protocols and families", async () => {
    await tree();
    const gateway = await listen("127.0.0.1");
    gateway.server.on("connection", (socket) => {
      socket.end();
    });
    const boof = await boofPort();
    expect(gateway.port).not.toBe(boof);
    const result = await run(basePolicy([boof]), [probe, "sock-allow", String(gateway.port)]);
    gateway.server.close();
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toEqual([
      "udp ok",
      "udp17 ok",
      "tcp ok",
      expect.stringMatching(/^icmp (ok|EACCES)$/),
      expect.stringMatching(/^icmp6 (ok|EACCES)$/),
      "seqpacket-inet EPERM",
      "netlink ok",
      "netlink-diag EPERM",
      "",
    ]);
  });

  it("allows stream and seqpacket socketpairs and denies datagram ones", async () => {
    await tree();
    const dir = await mkdtemp(join(tmpdir(), "boof-sandbox-pair-"));
    roots.push(dir);
    const dgramPath = join(dir, "dg.sock");
    const streamPath = join(dir, "stream.sock");
    const listener = spawn(probe, ["dgram-listen", dgramPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const listenerDone = new Promise<void>((resolve) => listener.once("close", () => resolve()));
    let heard = "";
    listener.stdout?.setEncoding("utf8");
    listener.stdout?.on("data", (chunk: string) => {
      heard += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`dgram listener did not bind: ${heard}`)),
        3000,
      );
      const onData = () => {
        if (!heard.includes("bound\n")) return;
        clearTimeout(timer);
        listener.stdout?.off("data", onData);
        resolve();
      };
      listener.stdout?.on("data", onData);
      onData();
    });
    const stream = createServer();
    let accepted = 0;
    stream.on("connection", (socket) => {
      accepted += 1;
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.listen(streamPath, () => resolve());
    });
    try {
      const result = await run(basePolicy([]), [probe, "pairs", dgramPath, streamPath]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        [
          "pair-dgram EPERM",
          "pair-dgram-flags EPERM",
          "pair-stream ok",
          "pair-seq ok",
          "pair-stream-connect EISCONN",
          "",
        ].join("\n"),
      );
      expect(heard).not.toContain("PWNED");
      expect(accepted).toBe(0);
    } finally {
      if (listener.exitCode === null && listener.signalCode === null) listener.kill("SIGTERM");
      await listenerDone;
      await new Promise<void>((resolve, reject) =>
        stream.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("A5 connects to another loopback port and reads the reply", async () => {
    await tree();
    const gateway = await listen("127.0.0.1");
    gateway.server.on("connection", (socket) => {
      socket.end("pong\n");
    });
    const boof = await boofPort();
    expect(gateway.port).not.toBe(boof);
    const text = basePolicy([boof]);
    const result = await run(text, [probe, "exchange4", String(gateway.port)]);
    gateway.server.close();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("exchange ok pong\n");
  });

  it("A6 denies ~/.ssh, the real ~/.claude.json and a file in /tmp", async () => {
    await tree();
    const text = basePolicy([]);
    const sshFile = join(homedir(), ".ssh", "x");
    const sshDir = join(homedir(), ".ssh");
    const claudeFile = join(homedir(), ".claude.json");
    const ssh = await run(text, [probe, "read", sshFile]);
    const sshTree = await run(text, [probe, "readdir", sshDir]);
    const claude = await run(text, [probe, "read", claudeFile]);
    const temp = await run(text, [probe, "read", tmpFile]);
    // A missing final component is ENOENT: Landlock does not hide that the name is absent.
    // An existing file or directory outside the policy is EACCES, and the read never returns bytes.
    const deniedOrAbsent = (stdout: string, present: boolean, label: string) => {
      if (present) expect(stdout).toBe(`${label} EACCES\n`);
      else expect([`${label} EACCES\n`, `${label} ENOENT\n`]).toContain(stdout);
    };
    deniedOrAbsent(ssh.stdout, existsSync(sshFile), "read");
    deniedOrAbsent(sshTree.stdout, existsSync(sshDir), "readdir");
    deniedOrAbsent(claude.stdout, existsSync(claudeFile), "read");
    expect(temp.stdout).toBe("read EACCES\n");
  });

  it("A7 denies a pathname unix socket and an abstract one", async () => {
    await tree();
    const sockPath = join(tmpdir(), `boof-sandbox-sock-${process.pid}`);
    const name = `boof-sandbox-${process.pid}`;
    const pathServer = createServer();
    const abstractServer = createServer();
    await new Promise<void>((resolve, reject) => {
      pathServer.once("error", reject);
      pathServer.listen(sockPath, () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      abstractServer.once("error", reject);
      abstractServer.listen(`\0${name}`, () => resolve());
    });
    const text = basePolicy([]);
    const pathResult = await run(text, [probe, "unix", sockPath]);
    const abstractResult = await run(text, [probe, "abstract", name]);
    pathServer.close();
    abstractServer.close();
    rmSync(sockPath, { force: true });
    expect(pathResult.stdout).toBe("unix EPERM\n");
    expect(abstractResult.stdout).toBe("abstract EPERM\n");
  });

  it("A8 denies /proc/<pid>/environ and, on ABI 6+, a signal to that pid", async () => {
    await tree();
    let signals = 0;
    const onSignal = () => {
      signals += 1;
    };
    process.on("SIGUSR1", onSignal);
    try {
      const text = basePolicy([]);
      const env = await run(text, [probe, "environ", String(process.pid)]);
      const signal = await run(text, [probe, "signal", String(process.pid)]);
      expect(env.stdout).toBe("environ EACCES\n");
      if (abi >= 6) {
        expect(signal.stdout).toBe("signal EPERM\n");
        expect(signals).toBe(0);
      }
    } finally {
      process.off("SIGUSR1", onSignal);
    }
  });

  it("A13 repeats the secret read and the boof-port connect after sh, a grandchild, setsid and a double fork", async () => {
    await tree();
    const port = await boofPort();
    const secret = join(data, "settings.json");
    const text = basePolicy([port]);
    const shellRead = await run(text, ["/bin/sh", "-c", `${probe} read ${secret}`]);
    expect(shellRead.stdout).toBe("read EACCES\n");
    const shellConnect = await run(text, ["/bin/sh", "-c", `${probe} connect4 ${port}`]);
    expect(shellConnect.stdout).toBe("connect EACCES\n");
    const grand = await run(text, ["/bin/sh", "-c", `/bin/sh -c '${probe} read ${secret}'`]);
    const grandConnect = await run(text, [
      "/bin/sh",
      "-c",
      `/bin/sh -c '${probe} connect4 ${port}'`,
    ]);
    expect(grand.stdout).toBe("read EACCES\n");
    expect(grandConnect.stdout).toBe("connect EACCES\n");
    const sidRead = await run(text, [probe, "setsid-read", secret]);
    const sidConnect = await run(text, [probe, "setsid-connect4", String(port)]);
    expect(sidRead.stdout).toBe("read EACCES\n");
    expect(sidConnect.stdout).toBe("connect EACCES\n");
    const doubleRead = await run(text, [probe, "double-read", secret]);
    const doubleConnect = await run(text, [probe, "double-connect4", String(port)]);
    expect(doubleRead.stdout).toBe("read EACCES\n");
    expect(doubleConnect.stdout).toBe("connect EACCES\n");
  });

  it("exits 126 when a readWrite path is missing and does not exec", async () => {
    const missing = join(tmpdir(), `boof-sandbox-missing-${process.pid}`);
    const marker = join(tmpdir(), `boof-sandbox-marker-${process.pid}`);
    rmSync(missing, { force: true });
    rmSync(marker, { force: true });
    const text = policy(existing(["/bin", "/usr", "/lib"]), [missing], []);
    const result = await run(text, ["/bin/touch", marker]);
    expectHelperError(result, `missing path: ${missing}`);
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 126 when the policy has an extra field", async () => {
    const text = `${JSON.stringify({
      version: 1,
      readExec: ["/usr"],
      readWrite: ["/tmp"],
      denyTcpPorts: [],
    }).slice(0, -1)},"extra":1}`;
    const result = await run(text, ["/bin/true"]);
    expectHelperError(result, "unknown policy field");
  });

  it("rejects a NUL code point in a policy string", async () => {
    await tree();
    const secret = join(data, "settings.json");
    const marker = join(work, "ran");
    const text = JSON.stringify({
      version: 1,
      readExec: [...existing(["/bin", "/usr", "/lib"]), `${secret}\u0000/../nothing`],
      readWrite: [work],
      denyTcpPorts: [],
    });
    expect(text).toContain("\\u0000");
    const result = await run(text, ["/bin/touch", marker]);
    expectHelperError(result, "policy string contains NUL");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(secret)).toBe(true);
  });

  it("rejects a NUL code point in a policy key", async () => {
    const marker = join(tmpdir(), `boof-sandbox-nul-key-${process.pid}`);
    rmSync(marker, { force: true });
    const text = `{"version":1,"readExec\\u0000":${JSON.stringify(existing(["/bin", "/usr", "/lib"]))},"readWrite":["/tmp"],"denyTcpPorts":[]}`;
    const result = await run(text, ["/bin/touch", marker]);
    expectHelperError(result, "policy string contains NUL");
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 126 on an unknown policy version", async () => {
    const text = JSON.stringify({
      version: 2,
      readExec: ["/usr"],
      readWrite: ["/tmp"],
      denyTcpPorts: [],
    });
    const result = await run(text, ["/bin/true"]);
    expectHelperError(result, "unknown policy version");
  });

  it("kills a non-Linux audit architecture in the seccomp filter", () => {
    const expected =
      process.arch === "arm64" ? "0xc00000b7" : process.arch === "x64" ? "0xc000003e" : "";
    expect(expected).not.toBe("");
    const result = spawnSync(filterCheck, [helper], { encoding: "utf8", timeout: 60000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`arch ${expected}`);
  });

  it("builds 65534 port rules in under 1s", async () => {
    await tree();
    const text = basePolicy([9]);
    const result = await run(text, [probe, "pair-connect4", "9", "1"], 5000);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("denied EACCES\nallowed ECONNREFUSED\n");
    expect(result.ms).toBeLessThan(1000);
  });

  it("build.mjs exits 0 with a message and no binary when the compiler is missing", () => {
    const out = join(dist, "boof-sandbox");
    const before = existsSync(out);
    const result = spawnSync(process.execPath, [join(here, "build.mjs")], {
      encoding: "utf8",
      env: { ...process.env, CC: "/no/such/boof-sandbox-cc" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "boof-sandbox: compiler not found (/no/such/boof-sandbox-cc); the sandbox is unavailable\n",
    );
    expect(existsSync(out)).toBe(before);
  });

  it("links statically for musl-gcc and for BOOF_SANDBOX_STATIC", () => {
    const log = join(dist, "cc-args.txt");
    const bin = join(dist, "fake-cc");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "musl-gcc");
    writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$BOOF_CC_LOG"\nexit 0\n');
    chmodSync(script, 0o755);
    const plain = join(bin, "cc");
    writeFileSync(plain, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$BOOF_CC_LOG"\nexit 0\n');
    chmodSync(plain, 0o755);
    const runBuild = (cc: string, extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, [join(here, "build.mjs")], {
        encoding: "utf8",
        env: { ...process.env, CC: cc, BOOF_CC_LOG: log, ...extra },
      });
    expect(runBuild(script).status).toBe(0);
    const muslArgs = readFileSync(log, "utf8");
    expect(muslArgs).toContain("-static");
    expect(muslArgs).toContain("-idirafter /usr/include");
    expect(runBuild(plain, { BOOF_SANDBOX_STATIC: "1" }).status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("-static");
    expect(runBuild(plain, { BOOF_SANDBOX_STATIC: "" }).status).toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("-static");
  });
});
