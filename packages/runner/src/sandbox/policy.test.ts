import { describe, expect, it } from "vitest";
import {
  buildSandboxPolicy,
  SANDBOX_DEVICES,
  SandboxPolicyError,
  type SandboxPolicyContext,
} from "./policy.js";

const TOOLS = ["claude-code", "claude-agent", "codex", "opencode", "mock"] as const;

const HOME = "/home/u";
const DATA = "/data";
const AGENT_HOME = "/state/agents/app/home";
const CACHE = "/state/agents/app/cache";
const TEMP = "/state/tmp/run1";
const WORKTREE = "/repos/app/.worktrees/task";
const PROJECT = "/repos/app";

function ctx(over: Partial<SandboxPolicyContext> = {}): SandboxPolicyContext {
  return {
    platform: "linux",
    dataRoot: DATA,
    home: HOME,
    serverRunning: true,
    boofPorts: [4319],
    readPaths: [],
    writePaths: [],
    denyTcpPorts: [],
    systemPaths: [
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/etc",
      "/opt",
      "/nix",
      "/snap",
      "/proc",
      "/sys",
      "/run/systemd/resolve",
      HOME,
      "/opt/homebrew",
    ],
    pathEntries: ["/usr/bin", HOME, `${HOME}/.bun/bin`],
    toolInstallRoot: "/usr/lib/node_modules/claude-code",
    toolchainPaths: [
      `${HOME}/.rustup`,
      `${HOME}/.cargo/bin`,
      `${HOME}/.nvm`,
      `${HOME}/.volta`,
      `${HOME}/go/bin`,
      `${HOME}/.ssh`,
    ],
    writableRoot: WORKTREE,
    tempDir: TEMP,
    agentHome: AGENT_HOME,
    cacheDir: CACHE,
    credentialMode: "key",
    tool: "claude-code",
    devices: [...SANDBOX_DEVICES, "/dev/shm"],
    git: { commonDir: `${PROJECT}/.git`, worktreeName: "task" },
    gitIdentity: {
      authorName: "Boof",
      authorEmail: "boof@example.com",
      committerName: "Boof",
      committerEmail: "boof@example.com",
    },
    ...over,
  };
}

function refusal(run: () => void): SandboxPolicyError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxPolicyError);
    return err as SandboxPolicyError;
  }
  throw new Error("expected SandboxPolicyError");
}

describe("buildSandboxPolicy", () => {
  it("grants the Linux path lists and hides the real home and the data root", () => {
    const policy = buildSandboxPolicy(ctx());
    expect(policy.version).toBe(1);
    expect(policy.readExec).toEqual([
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/etc",
      "/opt",
      "/nix",
      "/snap",
      "/proc",
      "/sys",
      "/run/systemd/resolve",
      "/usr/bin",
      `${HOME}/.bun/bin`,
      "/usr/lib/node_modules/claude-code",
      `${HOME}/.rustup`,
      `${HOME}/.cargo/bin`,
      `${HOME}/.nvm`,
      `${HOME}/.volta`,
      `${HOME}/go/bin`,
      `${PROJECT}/.git`,
    ]);
    expect(policy.readWrite).toEqual([
      WORKTREE,
      TEMP,
      AGENT_HOME,
      CACHE,
      `${AGENT_HOME}/claude-code/claude`,
      `${AGENT_HOME}/claude-code/codex`,
      `${AGENT_HOME}/claude-code/xdg-config`,
      `${AGENT_HOME}/claude-code/xdg-data`,
      `${AGENT_HOME}/claude-code/xdg-state`,
      ...SANDBOX_DEVICES,
      `${PROJECT}/.git/worktrees/task`,
      `${PROJECT}/.git/objects`,
      `${PROJECT}/.git/refs/heads/boof-runner`,
      `${PROJECT}/.git/logs`,
    ]);
    expect(policy.readExec).not.toContain(HOME);
    expect(policy.readWrite).not.toContain(HOME);
    expect(policy.readExec).not.toContain(DATA);
    expect(policy.readWrite).not.toContain(DATA);
    expect(policy.readExec.join("\n")).not.toContain(`${HOME}/.ssh`);
    expect(policy.readExec.join("\n")).not.toContain(`${HOME}/.claude`);
    expect(policy.readWrite.join("\n")).not.toContain(`${HOME}/.codex`);
    expect([...policy.readExec, ...policy.readWrite]).not.toContain("/tmp");
    expect([...policy.readExec, ...policy.readWrite]).not.toContain("/var/tmp");
    expect([...policy.readExec, ...policy.readWrite]).not.toContain("/dev/shm");
    expect(policy.env).toMatchObject({
      HOME: AGENT_HOME,
      TMPDIR: TEMP,
      TMP: TEMP,
      TEMP,
      XDG_CACHE_HOME: CACHE,
      npm_config_cache: `${CACHE}/npm`,
      BUN_INSTALL_CACHE_DIR: `${CACHE}/bun`,
      YARN_CACHE_FOLDER: `${CACHE}/yarn`,
      npm_config_store_dir: `${CACHE}/pnpm`,
      PIP_CACHE_DIR: `${CACHE}/pip`,
      GOCACHE: `${CACHE}/go-build`,
      GOMODCACHE: `${CACHE}/go-mod`,
      CARGO_HOME: `${CACHE}/cargo`,
      RUSTUP_HOME: `${HOME}/.rustup`,
      PATH: `/usr/bin:${HOME}/.bun/bin`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Boof",
      GIT_AUTHOR_EMAIL: "boof@example.com",
      GIT_COMMITTER_NAME: "Boof",
      GIT_COMMITTER_EMAIL: "boof@example.com",
      UV_USE_IO_URING: "0",
    });
    expect(policy.env.CARGO_HOME).not.toBe(`${HOME}/.cargo`);
  });

  describe("credential modes", () => {
    for (const tool of TOOLS) {
      it(`key mode for ${tool} keeps tool state under the agent home`, () => {
        const policy = buildSandboxPolicy(ctx({ tool, credentialMode: "key" }));
        const root = `${AGENT_HOME}/${tool}`;
        expect(policy.env.CLAUDE_CONFIG_DIR).toBe(`${root}/claude`);
        expect(policy.env.CODEX_HOME).toBe(`${root}/codex`);
        expect(policy.env.XDG_CONFIG_HOME).toBe(`${root}/xdg-config`);
        expect(policy.env.XDG_DATA_HOME).toBe(`${root}/xdg-data`);
        expect(policy.env.XDG_STATE_HOME).toBe(`${root}/xdg-state`);
        expect(policy.env.HOME).toBe(AGENT_HOME);
        for (const path of [
          policy.env.CLAUDE_CONFIG_DIR,
          policy.env.CODEX_HOME,
          policy.env.XDG_CONFIG_HOME,
          policy.env.XDG_DATA_HOME,
          policy.env.XDG_STATE_HOME,
        ]) {
          expect(path.startsWith(`${AGENT_HOME}/`)).toBe(true);
          expect(policy.readWrite).toContain(path);
        }
        for (const leaked of [
          `${HOME}/.claude`,
          `${HOME}/.codex`,
          `${HOME}/.config`,
          `${HOME}/.local`,
        ]) {
          expect(policy.readExec).not.toContain(leaked);
          expect(policy.readWrite).not.toContain(leaked);
        }
      });

      it(`login mode for ${tool} is refused`, () => {
        const err = refusal(() => buildSandboxPolicy(ctx({ tool, credentialMode: "login" })));
        expect(err.code).toBe("login_mode_refused");
        expect(err.message).toContain(`for ${tool}`);
        expect(err.message).toContain("use an API key or the account pool");
      });
    }

    it("refuses login mode on macOS because the Keychain cannot be opened in part", () => {
      const err = refusal(() =>
        buildSandboxPolicy(ctx({ platform: "darwin", tool: "codex", credentialMode: "login" })),
      );
      expect(err.code).toBe("login_mode_refused");
      expect(err.message).toContain("Keychain");
      expect(err.message).toContain("use an API key or the account pool");
    });
  });

  it("uses the project folder when the project has no worktree", () => {
    const policy = buildSandboxPolicy(
      ctx({
        writableRoot: PROJECT,
        git: undefined,
        gitIdentity: undefined,
      }),
    );
    expect(policy.readWrite[0]).toBe(PROJECT);
    expect(policy.readExec).not.toContain(`${PROJECT}/.git`);
    expect(policy.readWrite.some((p) => p.includes("/objects"))).toBe(false);
    expect(policy.readWrite.some((p) => p.includes("boof-runner"))).toBe(false);
    expect(policy.env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(policy.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  it("drops PATH entries that are $HOME or that contain the data root", () => {
    const policy = buildSandboxPolicy(
      ctx({
        dataRoot: "/srv/boof/data",
        home: HOME,
        pathEntries: [
          HOME,
          "/srv/boof",
          "/srv/boof/data/bin",
          "/home",
          `${HOME}/.bun/bin`,
          "/usr/bin",
        ],
        writableRoot: "/work/task",
        git: undefined,
      }),
    );
    expect(policy.readExec).not.toContain(HOME);
    expect(policy.readExec).not.toContain("/srv/boof");
    expect(policy.readExec).not.toContain("/srv/boof/data/bin");
    expect(policy.readExec).not.toContain("/home");
    expect(policy.readExec).toContain(`${HOME}/.bun/bin`);
    expect(policy.readExec).toContain("/usr/bin");
    expect(policy.env.PATH).toBe(`${HOME}/.bun/bin:/usr/bin`);
  });

  describe("refusals", () => {
    it("throws when the writable folder contains the data root (A15)", () => {
      const err = refusal(() =>
        buildSandboxPolicy(
          ctx({ writableRoot: PROJECT, dataRoot: `${PROJECT}/data`, git: undefined }),
        ),
      );
      expect(err.code).toBe("writable_contains_data_root");
      expect(err.message).toContain("contains the data root");
    });

    it("throws when the writable folder is the data root", () => {
      const err = refusal(() =>
        buildSandboxPolicy(ctx({ writableRoot: DATA, dataRoot: DATA, git: undefined })),
      );
      expect(err.code).toBe("writable_contains_data_root");
    });

    it("throws when the writable folder is inside the data root", () => {
      const err = refusal(() =>
        buildSandboxPolicy(
          ctx({ writableRoot: `${DATA}/projects/app`, dataRoot: DATA, git: undefined }),
        ),
      );
      expect(err.code).toBe("writable_contains_data_root");
      expect(err.message).toContain("inside the data root");
    });

    it("throws when an allowed path is an ancestor of the data root (A15)", () => {
      for (const field of ["readPaths", "writePaths"] as const) {
        const err = refusal(() =>
          buildSandboxPolicy(ctx({ dataRoot: `${PROJECT}/data`, [field]: ["/repos"] })),
        );
        expect(err.code).toBe("allowed_path_overlaps_data_root");
        expect(err.message).toContain("is the data root or an ancestor of it");
      }
    });

    it("throws when an allowed path is the data root or lies inside it", () => {
      const equal = refusal(() => buildSandboxPolicy(ctx({ readPaths: [DATA] })));
      expect(equal.message).toContain("is the data root or an ancestor of it");
      const inside = refusal(() => buildSandboxPolicy(ctx({ writePaths: [`${DATA}/auth`] })));
      expect(inside.code).toBe("allowed_path_overlaps_data_root");
      expect(inside.message).toContain("inside the data root");
    });

    it("throws when the boof port is unknown while a server is running", () => {
      const err = refusal(() => buildSandboxPolicy(ctx({ serverRunning: true, boofPorts: [] })));
      expect(err.code).toBe("boof_port_unknown");
      expect(err.message).toContain("boof port is unknown");
    });

    it("throws on Windows", () => {
      const err = refusal(() => buildSandboxPolicy(ctx({ platform: "win32" })));
      expect(err.code).toBe("windows_unsupported");
    });
  });

  it("puts every boof port in denyTcpPorts when the user lists nothing", () => {
    const alone = buildSandboxPolicy(ctx({ boofPorts: [4319], denyTcpPorts: [] }));
    expect(alone.denyTcpPorts).toEqual([4319]);
    const several = buildSandboxPolicy(
      ctx({
        boofPorts: [4319, 4320],
        desktopPort: 5173,
        denyTcpPorts: [443, 4319],
      }),
    );
    expect(several.denyTcpPorts).toEqual([4319, 4320, 5173, 443]);
  });

  it("keeps a known boof port when no server is running and the user lists nothing", () => {
    const policy = buildSandboxPolicy(
      ctx({ serverRunning: false, boofPorts: [4319], denyTcpPorts: [] }),
    );
    expect(policy.denyTcpPorts).toEqual([4319]);
  });

  it("adds extra read and write paths that do not overlap the data root", () => {
    const policy = buildSandboxPolicy(
      ctx({ readPaths: ["/opt/sdks"], writePaths: ["/opt/extra-write"] }),
    );
    expect(policy.readExec).toContain("/opt/sdks");
    expect(policy.readWrite).toContain("/opt/extra-write");
  });

  it("uses the macOS system roots and still writes the device nodes", () => {
    const policy = buildSandboxPolicy(
      ctx({
        platform: "darwin",
        systemPaths: ["/usr", "/opt/homebrew", "/lib64", "/System", "/dev"],
        git: undefined,
        writableRoot: "/work/task",
      }),
    );
    expect(policy.readExec).toContain("/usr");
    expect(policy.readExec).toContain("/opt/homebrew");
    expect(policy.readExec).toContain("/System");
    expect(policy.readExec).toContain("/dev");
    expect(policy.readExec).not.toContain("/lib64");
    expect(policy.readWrite).toContain("/dev/null");
  });

  it("refuses a shared temp directory and a git dir inside the writable folder", () => {
    expect(refusal(() => buildSandboxPolicy(ctx({ tempDir: "/tmp" }))).code).toBe(
      "temp_not_private",
    );
    expect(
      refusal(() =>
        buildSandboxPolicy(
          ctx({
            writableRoot: PROJECT,
            git: { commonDir: `${PROJECT}/.git`, worktreeName: "task" },
          }),
        ),
      ).code,
    ).toBe("git_inside_writable");
  });

  it("refuses a system path that contains the data root", () => {
    const err = refusal(() =>
      buildSandboxPolicy(ctx({ dataRoot: "/opt/boof", systemPaths: ["/opt", "/usr"] })),
    );
    expect(err.code).toBe("path_overlaps_data_root");
    expect(err.message).toContain("/opt");
  });
});
