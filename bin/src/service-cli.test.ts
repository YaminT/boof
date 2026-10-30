import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildUnit,
  envLine,
  execWord,
  mergePath,
  readInstallOptions,
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

  it("records the install options in a comment line that reads back", () => {
    const o = {
      name: "boof-runner",
      data: "/srv/boof",
      port: 4400,
      host: "127.0.0.1",
      nodePath: "/opt/node/bin/node",
      scriptPath: "/opt/boof/bin/dist/boof-runner.js",
      path: "/opt/node/bin:/usr/bin",
      home: "/home/svc",
      env: [["ANTHROPIC_BASE_URL", "https://proxy.example"]] as [string, string][],
      envFile: "/home/svc/boof.env",
    };
    const text = buildUnit(o);
    expect(text.split("\n")[0]).toMatch(/^# boof-runner-options: \{/);
    expect(readInstallOptions(text)).toEqual({
      data: "/srv/boof",
      port: 4400,
      host: "127.0.0.1",
      env: [["ANTHROPIC_BASE_URL", "https://proxy.example"]],
      envFile: "/home/svc/boof.env",
      path: "/opt/node/bin:/usr/bin",
    });
    expect(readInstallOptions("[Unit]\nDescription=old\n")).toBeUndefined();
    expect(readInstallOptions("# boof-runner-options: {broken\n[Unit]\n")).toBeUndefined();
    expect(mergePath("/new/bin:/usr/bin", "/home/y/.nvm/v22/bin:/usr/bin:/home/y/.local/bin")).toBe(
      "/new/bin:/usr/bin:/home/y/.nvm/v22/bin:/home/y/.local/bin",
    );
    expect(mergePath("/usr/bin", undefined)).toBe("/usr/bin");
  });

  it("round-trips values with newlines, #, quotes and % and keeps the unit valid", () => {
    const env: [string, string][] = [["K", 'a\nb # c "d" 100%']];
    const text = buildUnit({
      name: "x",
      data: "/d e",
      port: 1,
      host: "h",
      nodePath: "/n",
      scriptPath: "/s.js",
      path: "/p",
      home: "/h",
      env,
    });
    expect(readInstallOptions(text)?.env).toEqual(env);
    const comments = text.split("\n").filter((l) => l.startsWith("#"));
    expect(comments).toHaveLength(2);
    expect(text).toContain("100%%");
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
    expect(out.join("\n")).toContain("env: FOO");
    expect(out.join("\n")).toContain("PATH: from this shell");
    const text = await readFile(unitFile(), "utf8");
    expect(text).toBe(
      [
        `# boof-runner-options: ${JSON.stringify({ data, port: 4319, host: "127.0.0.1", env: [["FOO", "bar baz"]], path: "/home/yamin/.nvm/versions/node/v22.22.0/bin:/usr/bin" })}`,
        "# Options you omit on the next `boof-runner service install` are reused from this line (--reset starts over).",
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

  it("a reinstall with only --data keeps --env-file, --env, --port, --host and PATH, and prints what it kept", async () => {
    const envFile = join(home, "boof.env");
    await writeFile(envFile, "ANTHROPIC_AUTH_TOKEN=secret-token\n", { mode: 0o600 });
    expect(
      await run([
        "install",
        "--data",
        data,
        "--port",
        "4400",
        "--host",
        "127.0.0.1",
        "--env",
        "FOO=bar",
        "--env-file",
        envFile,
      ]),
    ).toBe(0);
    out = [];
    // The upgrade, from a bare ssh shell: new node, poorer PATH, only --data (the runbook's step).
    const bare = makeEnv({
      path: "/usr/local/bin:/usr/bin",
      nodePath: "/home/yamin/.nvm/versions/node/v22.23.0/bin/node",
    });
    expect(await run(["install", "--data", data], bare)).toBe(0);
    const text = await readFile(unitFile(), "utf8");
    expect(text).toContain(`EnvironmentFile=${envFile}\n`);
    expect(text).toContain("Environment=FOO=bar\n");
    expect(text).toContain(
      "Environment=PATH=/usr/local/bin:/usr/bin:/home/yamin/.nvm/versions/node/v22.22.0/bin\n",
    );
    expect(text).toContain(
      `ExecStart=/home/yamin/.nvm/versions/node/v22.23.0/bin/node ${script} serve -d ${data} -p 4400 --host 127.0.0.1\n`,
    );
    expect(text).not.toContain("secret-token");
    const printed = out.join("\n");
    expect(printed).toContain(`Reusing options recorded in ${unitFile()}`);
    expect(printed).toContain(`  data: ${data} (kept)`);
    expect(printed).toContain("  port: 4400 (kept)");
    expect(printed).toContain("  host: 127.0.0.1 (kept)");
    expect(printed).toContain(`  env-file: ${envFile} (kept)`);
    expect(printed).toContain("  env: FOO (kept)");
    expect(printed).toContain("  PATH: kept, 1 directory added from this shell");
    // The recorded line now carries the merged options, so a third install keeps them too.
    expect(readInstallOptions(text)).toMatchObject({ port: 4400, envFile, env: [["FOO", "bar"]] });
  });

  it("a flag given again overrides the kept value and is reported as changed", async () => {
    expect(await run(["install", "--data", data, "--port", "4400", "--env", "FOO=bar"])).toBe(0);
    out = [];
    expect(await run(["install", "--port", "4500", "--env", "FOO=baz", "--env", "NEW=1"])).toBe(0);
    const text = await readFile(unitFile(), "utf8");
    expect(text).toContain(` -p 4500 --host 127.0.0.1\n`);
    expect(text).toContain(`WorkingDirectory=${data}\n`); // --data kept
    expect(text).toContain("Environment=FOO=baz\n");
    expect(text).toContain("Environment=NEW=1\n");
    const printed = out.join("\n");
    expect(printed).toContain("  port: 4400 -> 4500");
    expect(printed).toContain("  env: FOO (changed), NEW (new)");
    expect(printed).toContain(`  data: ${data} (kept)`);
    expect(out.join("\n")).toContain("http://127.0.0.1:4500");
  });

  it("--reset ignores the previous install", async () => {
    const envFile = join(home, "boof.env");
    await writeFile(envFile, "X=1\n", { mode: 0o600 });
    expect(await run(["install", "--data", data, "--port", "4400", "--env-file", envFile])).toBe(0);
    out = [];
    expect(await run(["install", "--data", data, "--reset"])).toBe(0);
    const text = await readFile(unitFile(), "utf8");
    expect(text).not.toContain("EnvironmentFile=");
    expect(text).toContain(" -p 4319 ");
    expect(out.join("\n")).toContain("Ignoring the previous install's options (--reset)");
  });

  it("a unit without the options line installs from the flags alone", async () => {
    await mkdir(join(home, ".config/systemd/user"), { recursive: true });
    await writeFile(unitFile(), "[Unit]\nDescription=old\n\n[Service]\nExecStart=/x\n");
    expect(await run(["install", "--data", data])).toBe(0);
    expect(await readFile(unitFile(), "utf8")).toContain(` -p 4319 --host 127.0.0.1\n`);
    expect(out.join("\n")).toContain(
      "Previous unit has no recorded options; installing from the flags",
    );
  });

  it("a kept --env-file is re-checked: a file that became world-readable refuses the install", async () => {
    const envFile = join(home, "boof.env");
    await writeFile(envFile, "X=1\n", { mode: 0o600 });
    expect(await run(["install", "--data", data, "--env-file", envFile])).toBe(0);
    await chmod(envFile, 0o644);
    const before = await readFile(unitFile(), "utf8");
    expect(await run(["install", "--data", data])).toBe(1);
    expect(errs.join("\n")).toContain("is readable by other users");
    expect(await readFile(unitFile(), "utf8")).toBe(before); // nothing written
  });

  it("the unit is private (0600) because it records --env values, and the report never prints them", async () => {
    expect(await run(["install", "--data", data, "--env", "API_KEY=sk-very-secret"])).toBe(0);
    expect((await stat(unitFile())).mode & 0o777).toBe(0o600);
    out = [];
    expect(await run(["install", "--data", data, "--env", "API_KEY=sk-other-secret"])).toBe(0);
    expect(out.join("\n")).toContain("env: API_KEY (changed)");
    expect(out.join("\n")).not.toContain("secret");
    expect((await stat(unitFile())).mode & 0o777).toBe(0o600);
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
