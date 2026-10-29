import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildUnit,
  envLine,
  execWord,
  serviceCommand,
  type RunResult,
  type ServiceEnv,
} from "./service-cli.js";

let home: string;
let data: string;
let script: string;
let out: string[];
let errs: string[];
let calls: string[];
let streams: string[];
let active: boolean;
let linger: string;
let failOn: string | null;
let healthUrls: string[];

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

const makeEnv = (over: Partial<ServiceEnv> = {}): ServiceEnv => ({
  platform: "linux",
  home,
  user: "yamin",
  path: "/home/yamin/.nvm/versions/node/v22.22.0/bin:/usr/bin",
  nodePath: "/home/yamin/.nvm/versions/node/v22.22.0/bin/node",
  scriptPath: script,
  run: async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (failOn && line.includes(failOn)) return { code: 1, stdout: "", stderr: "boom" };
    if (line.includes("is-active")) return { code: active ? 0 : 3, stdout: "", stderr: "" };
    if (cmd === "loginctl") return ok(`Linger=${linger}\n`);
    if (line.includes(" status "))
      return ok("● boof-runner.service - Boof Runner\n   Active: active");
    return ok();
  },
  stream: async (cmd, args) => {
    streams.push(`${cmd} ${args.join(" ")}`);
    return 0;
  },
  health: async (url) => {
    healthUrls.push(url);
    return { ok: true, summary: "ok (version 0.2.0, up 3s, runner running)" };
  },
  ...over,
});

const run = (argv: string[], env: ServiceEnv = makeEnv()) =>
  serviceCommand(
    argv,
    () => data,
    (l) => out.push(l),
    (l) => errs.push(l),
    env,
  );

const unitFile = (name = "boof-runner") => join(home, ".config/systemd/user", `${name}.service`);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "boof-svc-home-"));
  data = join(home, "data");
  script = join(home, "boof-runner.js");
  await writeFile(script, "");
  out = [];
  errs = [];
  calls = [];
  streams = [];
  active = false;
  linger = "yes";
  failOn = null;
  healthUrls = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("unit file text", () => {
  it("quotes only what systemd needs", () => {
    expect(execWord("/usr/bin/node")).toBe("/usr/bin/node");
    expect(execWord("/my dir/x")).toBe('"/my dir/x"');
    expect(execWord("100%")).toBe("100%%");
    expect(envLine("PATH", "/a:/b")).toBe("Environment=PATH=/a:/b");
    expect(envLine("X", "a b")).toBe('Environment="X=a b"');
  });

  it("lets --env replace PATH and HOME", () => {
    const text = buildUnit({
      name: "x",
      data: "/d",
      port: 1,
      host: "127.0.0.1",
      nodePath: "/n",
      scriptPath: "/s.js",
      path: "/p",
      home: "/h",
      env: [["PATH", "/q"]],
    });
    expect(text).toContain("Environment=PATH=/q");
    expect(text).not.toContain("Environment=PATH=/p");
    expect(text).toContain("Environment=HOME=/h");
  });
});

describe("service install", () => {
  it("writes the unit and runs daemon-reload then enable --now", async () => {
    const code = await run(["install", "--data", data, "--env", "FOO=bar baz"]);
    expect(code).toBe(0);
    const text = await readFile(unitFile(), "utf8");
    expect(text).toBe(
      [
        "[Unit]",
        "Description=Boof Runner (boof-runner)",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=/home/yamin/.nvm/versions/node/v22.22.0/bin/node ${script} serve -d ${data} -p 4319 --host 127.0.0.1`,
        `WorkingDirectory=${data}`,
        "Restart=on-failure",
        "RestartSec=5",
        "TimeoutStopSec=60",
        "Environment=PATH=/home/yamin/.nvm/versions/node/v22.22.0/bin:/usr/bin",
        `Environment=HOME=${home}`,
        'Environment="FOO=bar baz"',
        "NoNewPrivileges=yes",
        "UMask=0077",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    expect(calls.filter((c) => c.startsWith("systemctl")).slice(0, 4)).toEqual([
      "systemctl --user show-environment",
      "systemctl --user is-active --quiet boof-runner.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now boof-runner.service",
    ]);
    expect(calls.some((c) => c.includes(" restart "))).toBe(false);
    expect(out.join("\n")).toContain("http://127.0.0.1:4319");
    expect(out.join("\n")).not.toContain("lingering is off");
  });

  it("--env-file adds EnvironmentFile= and keeps the secret out of the unit", async () => {
    const envFile = join(home, "boof.env");
    await writeFile(envFile, "ANTHROPIC_AUTH_TOKEN=secret-token\n", { mode: 0o600 });
    expect(await run(["install", "--data", data, "--env-file", envFile])).toBe(0);
    const text = await readFile(unitFile(), "utf8");
    expect(text).toContain(`EnvironmentFile=${envFile}\n`);
    expect(text).not.toContain("secret-token");
  });

  it("--env-file refuses a missing or group/world-readable file and writes nothing", async () => {
    expect(await run(["install", "--data", data, "--env-file", join(home, "nope.env")])).toBe(1);
    expect(errs.join("\n")).toContain("does not exist");
    const loose = join(home, "loose.env");
    await writeFile(loose, "A=1\n", { mode: 0o644 });
    expect(await run(["install", "--data", data, "--env-file", loose])).toBe(1);
    expect(errs.join("\n")).toContain("chmod 600");
    expect(existsSync(unitFile())).toBe(false);
  });

  it("restarts a service that was already active and honours --name, --port, --host", async () => {
    active = true;
    expect(await run(["install", "-d", data, "--name", "boof2", "-p", "5000"])).toBe(0);
    expect(existsSync(unitFile("boof2"))).toBe(true);
    expect(await readFile(unitFile("boof2"), "utf8")).toContain("-p 5000 --host 127.0.0.1");
    expect(calls).toContain("systemctl --user restart boof2.service");
  });

  it("warns when lingering is off and prints the command", async () => {
    linger = "no";
    expect(await run(["install", "-d", data])).toBe(0);
    expect(out.join("\n")).toContain("sudo loginctl enable-linger yamin");
  });

  it("refuses a non-loopback host the server would refuse, and writes nothing", async () => {
    const code = await run(["install", "-d", data, "--host", "0.0.0.0"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("refusing to bind 0.0.0.0");
    expect(errs.join("\n")).toContain("boof-runner remote setup --hostname");
    expect(existsSync(unitFile())).toBe(false);
    expect(calls.some((c) => c.includes("daemon-reload"))).toBe(false);
  });

  it("rejects bad input", async () => {
    expect(await run(["install", "-d", data, "-p", "99999"])).toBe(1);
    expect(await run(["install", "-d", data, "--env", "nokey"])).toBe(1);
    expect(await run(["install", "-d", data, "--name", "bad name"])).toBe(1);
    expect(existsSync(unitFile())).toBe(false);
  });

  it("fails with a clear message when the CLI is not built", async () => {
    await rm(script);
    expect(await run(["install", "-d", data])).toBe(1);
    expect(errs.join("\n")).toContain("build first");
  });

  it("reports a failing systemctl step", async () => {
    failOn = "enable --now";
    expect(await run(["install", "-d", data])).toBe(1);
    expect(errs.join("\n")).toContain("enable --now");
  });
});

describe("platform and systemd checks", () => {
  it("explains the manual alternative on non-Linux", async () => {
    for (const sub of ["install", "uninstall", "status", "logs"]) {
      errs = [];
      expect(await run([sub, "-d", data], makeEnv({ platform: "darwin" }))).toBe(1);
      expect(errs.join("\n")).toContain("only Linux with systemd");
      expect(errs.join("\n")).toContain("tmux");
    }
    expect(calls).toEqual([]);
  });

  it("explains an unreachable user manager", async () => {
    const env = makeEnv({
      run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }),
    });
    expect(await run(["install", "-d", data], env)).toBe(1);
    expect(errs.join("\n")).toContain("XDG_RUNTIME_DIR");
    expect(existsSync(unitFile())).toBe(false);
  });
});

describe("uninstall, status and logs", () => {
  it("uninstall disables, removes the unit and reloads", async () => {
    await run(["install", "-d", data]);
    calls = [];
    expect(await run(["uninstall"])).toBe(0);
    expect(existsSync(unitFile())).toBe(false);
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user disable --now boof-runner.service",
      "systemctl --user daemon-reload",
      "systemctl --user reset-failed boof-runner.service",
    ]);
  });

  it("status shows systemctl output and the /healthz result on the unit's port", async () => {
    await run(["install", "-d", data, "-p", "4400"]);
    out = [];
    expect(await run(["status"])).toBe(0);
    expect(calls).toContain("systemctl --user status boof-runner.service --no-pager --lines=10");
    expect(healthUrls).toEqual(["http://127.0.0.1:4400"]);
    expect(out.join("\n")).toContain("healthz: ok (version 0.2.0");
  });

  it("status fails when healthz is unreachable", async () => {
    const env = makeEnv({ health: async () => ({ ok: false, summary: "unreachable (x)" }) });
    expect(await run(["status"], env)).toBe(1);
  });

  it("logs runs journalctl --user -u, following with -f", async () => {
    expect(await run(["logs", "--name", "boof2"])).toBe(0);
    expect(await run(["logs", "-f", "-n", "20"])).toBe(0);
    expect(streams).toEqual([
      "journalctl --user -u boof2.service -n 100 --no-pager",
      "journalctl --user -u boof-runner.service -n 20 -f",
    ]);
  });

  it("prints help and rejects unknown subcommands", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(await run([])).toBe(1);
    expect(await run(["bogus"])).toBe(1);
  });
});
