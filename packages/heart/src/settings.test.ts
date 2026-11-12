import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataRootPaths } from "./paths.js";
import {
  checkProfiles,
  conciergeSettings,
  effectiveSettings,
  resolveRoleOrOff,
  resolveObserver,
  resolveRole,
  resolveWorktreeRoot,
  retrySettings,
  reviewSettings,
  SettingsStore,
  securitySettings,
  updatesSettings,
  worktreeSettings,
} from "./settings.js";
import { defaultSettings } from "./settings.js";
import { newTask, parseTask, serializeTask } from "./task-file.js";
import {
  ConciergeSettingsSchema,
  OrchestrationProfileSchema,
  ProjectPatchSchema,
  TaskFrontmatterSchema,
  RoleAssignmentSchema,
  SETTINGS_SCHEMA_VERSION,
  SandboxSettingsSchema,
  SettingsPatchSchema,
  SettingsSchema,
  type Project,
  type Settings,
  type TaskFrontmatter,
} from "./schema.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-settings-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "t1",
  title: "T1",
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  runs: 1,
  completedRuns: 0,
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

describe("concierge settings", () => {
  const defaults = {
    enabled: true,
    tool: "auto",
    model: "default",
    perMessageUsd: 0.25,
    perConversationUsd: 2,
    messagesPerMinute: 6,
    maxTurns: 8,
    timeoutMs: 120_000,
    idleMinutes: 30,
  };

  it("conciergeSettings({}) returns every default", () => {
    expect(conciergeSettings({} as Settings)).toEqual(defaults);
    // Scaffolded settings stay unchanged: the defaults are applied at read time.
    expect(defaultSettings().concierge).toBeUndefined();
  });

  it("rejects a zero per-message cap and a model with a space", () => {
    expect(ConciergeSettingsSchema.safeParse({ perMessageUsd: 0 }).success).toBe(false);
    expect(ConciergeSettingsSchema.safeParse({ model: "a b" }).success).toBe(false);
  });
});

describe("settings compatibility", () => {
  it("adds the claude-agent model without changing default role tools", () => {
    const settings = defaultSettings();
    expect(settings.models["claude-agent"]).toEqual(["default"]);
    expect(settings.roles.planner.tool).toBe("claude-code");
    expect(settings.roles.reviewer.tool).toBe("claude-code");
  });
  it("allows an empty model only for Codex role assignments", () => {
    expect(RoleAssignmentSchema.safeParse({ tool: "codex", model: "" }).success).toBe(true);
    expect(RoleAssignmentSchema.safeParse({ tool: "mock", model: "" }).success).toBe(false);
  });
  it("rejects whitespace-only models", () => {
    expect(RoleAssignmentSchema.safeParse({ tool: "codex", model: "  gpt-5.5  " }).success).toBe(
      true,
    );
    expect(RoleAssignmentSchema.safeParse({ tool: "codex", model: "  " }).success).toBe(false);
    expect(RoleAssignmentSchema.safeParse({ tool: "claude-code", model: "  " }).success).toBe(
      false,
    );
  });
  it("reports invalid gateway URLs as settings validation errors when loading", async () => {
    const path = dataRootPaths(root).settings;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...defaultSettings(), owlish: { url: "not a url" } }));
    await expect(new SettingsStore(root).load()).rejects.toThrow(/Invalid URL|validation|url/i);
  });
  it("loads an old settings.json without observer or review", async () => {
    const old = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runner: { enabled: false },
      roles: {
        planner: { tool: "mock", model: "m" },
        developer: { tool: "mock", model: "m" },
        reviewer: { tool: "mock", model: "m" },
      },
      models: { mock: ["m"] },
    };
    const path = dataRootPaths(root).settings;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(old), "utf8");
    const s = await new SettingsStore(root).load();
    expect(s.roles.observer).toBeUndefined();
    expect(reviewSettings(s)).toEqual({ gate: true, maxFixRounds: 2, maxInlineDiffBytes: 120000 });
    expect(resolveObserver(s, newTask(fm()))).toBeUndefined();
    expect(worktreeSettings(s)).toEqual({ onDone: "keep-branch", onFailure: "keep" });
    expect(retrySettings(s)).toEqual({
      transient: 2,
      backoffMs: [30000, 120000],
      idleTimeoutMs: 1200000,
      poolWaitMs: 1800000,
    });
    expect(s.runner.concurrency).toBe(1);
    expect(s.defaultProject).toBeNull();
    expect(resolveWorktreeRoot(worktreeSettings(s), "/tmp/x")).toBe(
      join("/tmp/x", ".boof-runner-worktrees"),
    );
  });

  it("round-trips worktree and retry settings", async () => {
    const store = new SettingsStore(root);
    const s = defaultSettings();
    s.worktree = { root: "/tmp/wt", onDone: "delete", onFailure: "delete" };
    s.retries = { transient: 5, backoffMs: [1], idleTimeoutMs: 10, poolWaitMs: 1000 };
    await store.save(s);
    const loaded = await store.load();
    expect(worktreeSettings(loaded)).toEqual(s.worktree);
    expect(retrySettings(loaded)).toEqual(s.retries);
  });

  it("round-trips the task base ref", () => {
    const task = newTask(fm({ base: "main" }), "p");
    expect(parseTask(serializeTask(task)).frontmatter.base).toBe("main");
    expect(parseTask(serializeTask(newTask(fm(), "p"))).frontmatter.base).toBeUndefined();
  });

  it("resolves the worktree root: unset, relative, ~, absolute", () => {
    const wd = "/tmp/x";
    expect(resolveWorktreeRoot({}, wd)).toBe(join(wd, ".boof-runner-worktrees"));
    expect(resolveWorktreeRoot({ root: "../wt" }, wd)).toBe(resolve(wd, "../wt"));
    expect(resolveWorktreeRoot({ root: "~/wts/a" }, wd)).toBe(join(homedir(), "wts", "a"));
    expect(resolveWorktreeRoot({ root: "~" }, wd)).toBe(homedir());
    expect(resolveWorktreeRoot({ root: "/abs/wt" }, wd)).toBe("/abs/wt");
  });

  it("round-trips observer and review settings", async () => {
    const store = new SettingsStore(root);
    const s = defaultSettings();
    s.roles.observer = { tool: "mock", model: "mock-default" };
    s.review = { gate: false, maxFixRounds: 5, maxInlineDiffBytes: 10 };
    await store.save(s);
    const loaded = await store.load();
    expect(loaded.roles.observer).toEqual({ tool: "mock", model: "mock-default" });
    expect(reviewSettings(loaded)).toEqual({
      gate: false,
      maxFixRounds: 5,
      maxInlineDiffBytes: 10,
    });
  });

  it("per-task tools.observer wins over the global observer", () => {
    const s = defaultSettings();
    s.roles.observer = { tool: "mock", model: "global" };
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "task" } } }));
    expect(resolveObserver(s, task)?.model).toBe("task");
    expect(resolveObserver(s, newTask(fm()))?.model).toBe("global");
    expect(resolveRole(s, task, "reviewer")).toEqual(s.roles.reviewer);
  });

  it("resolveRole honours observer: task, then global, then undefined", () => {
    const s = defaultSettings();
    expect(resolveRole(s, newTask(fm()), "observer")).toBeUndefined();
    s.roles.observer = { tool: "mock", model: "global" };
    expect(resolveRole(s, newTask(fm()), "observer")?.model).toBe("global");
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "task" } } }));
    expect(resolveRole(s, task, "observer")?.model).toBe("task");
  });
});

describe("legacy settings.json compatibility", () => {
  it("loads a file without review/worktree/retries/security and does not write defaults", async () => {
    const legacy = { ...defaultSettings() };
    const paths = dataRootPaths(root);
    await mkdir(dirname(paths.settings), { recursive: true });
    await writeFile(paths.settings, JSON.stringify(legacy, null, 2) + "\n");
    const store = new SettingsStore(root);
    const loaded = await store.load();
    expect(loaded).toEqual(legacy);
    expect(Object.keys(loaded)).not.toContain("security");
    const saved = await store.save(loaded);
    expect(saved).toEqual(legacy);
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toEqual(legacy);
  });

  it("fills nested security defaults from an empty or partial object", () => {
    const s = defaultSettings();
    expect(securitySettings(s)).toEqual({
      allowedHosts: [],
      auth: { mode: "local-trust" },
      allowedPrivateWebhookHosts: [],
      allowedProjectRoots: [],
      externalTasksRequireApproval: true,
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute: 30 },
      trustedProxies: ["loopback"],
      audit: { enabled: true, retentionDays: 90 },
    });
    expect(
      securitySettings({ ...s, security: { rateLimit: { perMinute: 5 } } as never }).rateLimit,
    ).toEqual({ perMinute: 5, attachmentsPerMinute: 30, unauthenticatedPerMinute: 30 });
  });
});

describe("v2 settings store", () => {
  it("round-trips projectsRoot and SettingsPatchSchema accepts it (null clears)", async () => {
    const store = new SettingsStore(root);
    await store.save({ ...defaultSettings(), projectsRoot: "~/p" });
    expect((await store.load()).projectsRoot).toBe("~/p");
    expect(SettingsPatchSchema.parse({ projectsRoot: null })).toEqual({ projectsRoot: null });
    expect(SettingsPatchSchema.safeParse({ projectsRoot: "" }).success).toBe(false);
    expect((await store.update({ projectsRoot: null })).projectsRoot).toBeUndefined();
  });

  it("scaffolds defaults at this release's schema, no default project, concurrency 1, no workingDirectory", async () => {
    const s = await new SettingsStore(root).load();
    expect(s.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(s.defaultProject).toBeNull();
    expect(s.runner).toEqual({
      enabled: false,
      concurrency: 1,
      inheritMcpServers: false,
      sandbox: { mode: "off", readPaths: [], writePaths: [], denyTcpPorts: [] },
    });
    expect(Object.keys(s)).not.toContain("workingDirectory");
  });

  it("refuses a v1 file with a pointer to the migration", async () => {
    const path = dataRootPaths(root).settings;
    await writeFile(path, JSON.stringify({ runner: { enabled: false }, workingDirectory: "/x" }));
    await expect(new SettingsStore(root).load()).rejects.toThrow(/v1 settings file/);
  });

  it("refuses a 0.3.0 schema 2 file with one line, not a schema dump", async () => {
    const path = dataRootPaths(root).settings;
    await writeFile(path, JSON.stringify({ ...defaultSettings(), schemaVersion: 2 }));
    const err = await new SettingsStore(root).load().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe(
      `${path} is a 0.3.0 settings file; start boof-runner (any command) to migrate the data root`,
    );
    expect(message).not.toMatch(/schemaVersion|expected 3|Zod/i);
    expect(message).not.toContain("\n");
  });

  it("update merges runner per key, so enabling the runner keeps the concurrency", async () => {
    const store = new SettingsStore(root);
    await store.update({ runner: { concurrency: 3 } });
    const s = await store.update({ runner: { enabled: true } });
    expect(s.runner).toEqual({
      enabled: true,
      concurrency: 3,
      inheritMcpServers: false,
      sandbox: { mode: "off", readPaths: [], writePaths: [], denyTcpPorts: [] },
    });
  });

  it("update serializes concurrent patches so neither is lost", async () => {
    const store = new SettingsStore(root);
    await store.load();
    await Promise.all([
      store.update({ runner: { enabled: true } }),
      store.update({ runner: { concurrency: 3 } }),
    ]);
    expect((await store.load()).runner).toEqual({
      enabled: true,
      concurrency: 3,
      inheritMcpServers: false,
      sandbox: { mode: "off", readPaths: [], writePaths: [], denyTcpPorts: [] },
    });
  });

  it("SettingsPatchSchema rejects workingDirectory and accepts defaultProject", () => {
    expect(SettingsPatchSchema.safeParse({ workingDirectory: "/x" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ defaultProject: "app" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ defaultProject: null }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ defaultProject: "Not Kebab" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ runner: { enabled: true } }).success).toBe(true);
  });
});

describe("effectiveSettings", () => {
  const project = (over: Partial<Project> = {}): Project => ({
    id: "app",
    name: "app",
    workingDirectory: "/repos/app",
    paused: false,
    archived: false,
    planWriteBack: true,
    labels: [],
    origin: { kind: "cli" },
    created: "2026-06-04T10:00:00.000Z",
    updated: "2026-06-04T10:00:00.000Z",
    ...over,
  });

  it("adds the project's working directory and leaves global settings alone without overrides", () => {
    const g = defaultSettings();
    const e = effectiveSettings(g, project());
    expect(e.workingDirectory).toBe("/repos/app");
    expect(e.roles).toEqual(g.roles);
    expect(e.runner).toEqual(g.runner);
  });

  it("passes the project claudeAgent auth choice through unchanged", () => {
    const projectSettings = project({ claudeAgent: { auth: "project-key" } });
    expect(effectiveSettings(defaultSettings(), projectSettings).claudeAgent).toEqual({
      auth: "project-key",
    });
  });

  it("merges roles, review, worktree and retries per key with the project winning", () => {
    const g = defaultSettings();
    g.review = { gate: true, maxFixRounds: 2, maxInlineDiffBytes: 100 };
    g.worktree = { root: "/global/wt", onDone: "keep-branch", onFailure: "keep" };
    g.retries = { transient: 2, backoffMs: [1], idleTimeoutMs: 5 };
    const e = effectiveSettings(
      g,
      project({
        roles: { developer: { tool: "mock", model: "p-dev" } },
        review: { maxFixRounds: 7 },
        worktree: { root: "/project/wt" },
        retries: { transient: 0 },
      }),
    );
    expect(e.roles.developer).toEqual({ tool: "mock", model: "p-dev" });
    expect(e.roles.planner).toEqual(g.roles.planner);
    expect(reviewSettings(e)).toEqual({ gate: true, maxFixRounds: 7, maxInlineDiffBytes: 100 });
    expect(worktreeSettings(e)).toEqual({
      root: "/project/wt",
      onDone: "keep-branch",
      onFailure: "keep",
    });
    expect(retrySettings(e).transient).toBe(0);
    expect(retrySettings(e).backoffMs).toEqual([1]);
    expect(resolveWorktreeRoot(worktreeSettings(e), e.workingDirectory)).toBe("/project/wt");
    // The global settings object is not mutated.
    expect(g.roles.developer).toEqual({ tool: "codex", model: "" });
    expect(g.models.codex).toEqual([]);
  });

  it("falls back to <workingDirectory>/.boof-runner-worktrees per project", () => {
    const g = defaultSettings();
    const e = effectiveSettings(g, project({ worktree: { onDone: "delete" } }));
    expect(resolveWorktreeRoot(worktreeSettings(e), e.workingDirectory)).toBe(
      join("/repos/app", ".boof-runner-worktrees"),
    );
    expect(worktreeSettings(e).onDone).toBe("delete");
  });

  it("applies a per-task override on top of the project's role", () => {
    const e = effectiveSettings(
      defaultSettings(),
      project({ roles: { reviewer: { tool: "mock", model: "p-rev" } } }),
    );
    expect(resolveRole(e, newTask(fm()), "reviewer").model).toBe("p-rev");
    const task = newTask(fm({ tools: { reviewer: { tool: "mock", model: "t-rev" } } }));
    expect(resolveRole(e, task, "reviewer").model).toBe("t-rev");
  });
});

describe("updates.check", () => {
  it("is on when the block is absent, and a patch can turn it off", async () => {
    expect(defaultSettings().updates).toBeUndefined();
    expect(updatesSettings(defaultSettings()).check).toBe(true);
    expect(SettingsPatchSchema.parse({ updates: { check: false } })).toEqual({
      updates: { check: false },
    });
    expect(SettingsPatchSchema.safeParse({ updates: { check: "yes" } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ updates: {} }).success).toBe(false);
    const store = new SettingsStore(root);
    await store.save(defaultSettings());
    await store.update({ updates: { check: false } });
    expect(updatesSettings(await store.load()).check).toBe(false);
  });
});

describe("runner.inheritMcpServers", () => {
  it("is off by default and can be switched on through a settings patch", async () => {
    expect(defaultSettings().runner.inheritMcpServers).toBe(false);
    expect(SettingsPatchSchema.parse({ runner: { inheritMcpServers: true } })).toEqual({
      runner: { inheritMcpServers: true },
    });
  });
});

const offSandbox = {
  mode: "off" as const,
  readPaths: [] as string[],
  writePaths: [] as string[],
  denyTcpPorts: [] as number[],
};

describe("runner.sandbox", () => {
  it("defaults to off with empty lists, including an old file that has no sandbox key", () => {
    expect(defaultSettings().runner.sandbox).toEqual(offSandbox);
    expect(SandboxSettingsSchema.parse({}).mode).toBe("off");
    expect(
      SettingsSchema.parse({ ...defaultSettings(), runner: { enabled: true } }).runner.sandbox,
    ).toEqual(offSandbox);
    const old = SettingsSchema.parse({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runner: { enabled: false },
      roles: defaultSettings().roles,
      models: defaultSettings().models,
    });
    expect(old.runner.sandbox).toEqual(offSandbox);
  });

  it("accepts absolute paths and ports 1 to 65535, and refuses the rest", () => {
    expect(
      SandboxSettingsSchema.parse({
        mode: "enforce",
        readPaths: ["/opt/sdks"],
        writePaths: ["/var/cache/boof"],
        denyTcpPorts: [1, 65535],
      }),
    ).toEqual({
      mode: "enforce",
      readPaths: ["/opt/sdks"],
      writePaths: ["/var/cache/boof"],
      denyTcpPorts: [1, 65535],
    });
    for (const readPaths of ["rel", "./rel", "~/x", ""]) {
      expect(SandboxSettingsSchema.safeParse({ readPaths: [readPaths] }).success).toBe(false);
    }
    for (const port of [0, -1, 65536, 1.5]) {
      expect(SandboxSettingsSchema.safeParse({ denyTcpPorts: [port] }).success).toBe(false);
    }
  });

  it("refuses unknown keys on the stored value and on a patch", () => {
    expect(SandboxSettingsSchema.safeParse({ mode: "off", extra: true }).success).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ runner: { sandbox: { mode: "off", extra: 1 } } }).success,
    ).toBe(false);
    expect(SettingsPatchSchema.safeParse({ runner: { sandbox: { nope: true } } }).success).toBe(
      false,
    );
    expect(
      SettingsSchema.safeParse({
        ...defaultSettings(),
        runner: { ...defaultSettings().runner, sandbox: { mode: "off", extra: 1 } },
      }).success,
    ).toBe(false);
  });

  it("a mode-only patch keeps the path lists", async () => {
    const store = new SettingsStore(root);
    await store.update({
      runner: {
        sandbox: {
          mode: "off",
          readPaths: ["/opt/sdks"],
          writePaths: ["/opt/out"],
          denyTcpPorts: [9],
        },
      },
    });
    const next = await store.update({ runner: { sandbox: { mode: "enforce" } } });
    expect(next.runner.sandbox).toEqual({
      mode: "enforce",
      readPaths: ["/opt/sdks"],
      writePaths: ["/opt/out"],
      denyTcpPorts: [9],
    });
    expect(next.runner.concurrency).toBe(1);
  });
});

describe("runner.agentEnv", () => {
  it("lists extra environment variable names for the agents and is empty by default", () => {
    expect(defaultSettings().runner.agentEnv ?? []).toEqual([]);
    expect(SettingsPatchSchema.parse({ runner: { agentEnv: ["GITHUB_TOKEN", "MY_VAR"] } })).toEqual(
      {
        runner: { agentEnv: ["GITHUB_TOKEN", "MY_VAR"] },
      },
    );
    expect(() => SettingsPatchSchema.parse({ runner: { agentEnv: ["bad name"] } })).toThrow();
    expect(() => SettingsPatchSchema.parse({ runner: { agentEnv: ["A=B"] } })).toThrow();
  });
});

describe("orchestration profiles", () => {
  const project = (over: Partial<Project> = {}): Project => ({
    id: "app",
    name: "app",
    workingDirectory: "/repos/app",
    paused: false,
    archived: false,
    planWriteBack: true,
    labels: [],
    origin: { kind: "cli" },
    created: "2026-06-04T10:00:00.000Z",
    updated: "2026-06-04T10:00:00.000Z",
    ...over,
  });
  const A = { tool: "mock", model: "a" };
  const B = { tool: "mock", model: "b" };
  const C = { tool: "mock", model: "c" };
  const profile = (over: Record<string, unknown> = {}) => ({
    id: "lean",
    name: "Lean",
    roles: { planner: null, developer: B, observer: null, reviewer: null },
    ...over,
  });

  it("a 0.5.0 settings file loads unchanged, with no profile keys", () => {
    const parsed = SettingsSchema.parse(defaultSettings());
    expect(parsed.profiles).toBeUndefined();
    expect(parsed.activeProfile).toBeUndefined();
    expect(parsed.schemaVersion).toBe(3);
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
  });

  it("the profile schema is strict and limited to tool+model", () => {
    expect(OrchestrationProfileSchema.safeParse(profile()).success).toBe(true);
    expect(OrchestrationProfileSchema.safeParse(profile({ env: { KEY: "x" } })).success).toBe(
      false,
    );
    expect(OrchestrationProfileSchema.safeParse(profile({ apiKey: "sk-x" })).success).toBe(false);
    const withExtra = profile({
      roles: { planner: null, developer: { ...B, apiKey: "sk-x" }, reviewer: null },
    });
    expect(OrchestrationProfileSchema.safeParse(withExtra).success).toBe(true); // role objects strip
    expect(
      OrchestrationProfileSchema.safeParse(
        profile({ roles: { planner: null, developer: B, reviewer: null, extra: A } }),
      ).success,
    ).toBe(false);
  });

  it("roles: planner and reviewer may be null, the developer may not; observer defaults to off", () => {
    const parsed = OrchestrationProfileSchema.parse(
      profile({ roles: { planner: null, developer: B, reviewer: null } }),
    );
    expect(parsed.roles.observer).toBeNull();
    expect(
      OrchestrationProfileSchema.safeParse(
        profile({ roles: { planner: null, developer: null, reviewer: null } }),
      ).success,
    ).toBe(false);
    expect(
      OrchestrationProfileSchema.safeParse(profile({ roles: { developer: B, reviewer: null } }))
        .success,
    ).toBe(false);
  });

  it("limits: name length, id shape, fix rounds, 20 profiles", () => {
    expect(OrchestrationProfileSchema.safeParse(profile({ name: "x".repeat(61) })).success).toBe(
      false,
    );
    expect(OrchestrationProfileSchema.safeParse(profile({ name: "  " })).success).toBe(false);
    expect(OrchestrationProfileSchema.safeParse(profile({ id: "Not Kebab" })).success).toBe(false);
    expect(OrchestrationProfileSchema.safeParse(profile({ maxFixRounds: 11 })).success).toBe(false);
    expect(OrchestrationProfileSchema.safeParse(profile({ maxFixRounds: 10 })).success).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => profile({ id: `p-${i}` }));
    expect(SettingsPatchSchema.safeParse({ profiles: many }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ profiles: many.slice(0, 20) }).success).toBe(true);
  });

  it("the patch and project patch accept the new keys; unknown ones stay refused", () => {
    expect(SettingsPatchSchema.safeParse({ activeProfile: null }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ activeProfiles: "x" }).success).toBe(false);
    expect(ProjectPatchSchema.safeParse({ profile: "lean" }).success).toBe(true);
    expect(ProjectPatchSchema.safeParse({ profile: null }).success).toBe(true);
    expect(ProjectPatchSchema.safeParse({ profile: "Bad Id" }).success).toBe(false);
  });

  it("concierge.tool defaults to auto and accepts the three values", () => {
    expect(conciergeSettings(defaultSettings()).tool).toBe("auto");
    for (const tool of ["auto", "claude-agent", "claude-code"]) {
      expect(ConciergeSettingsSchema.safeParse({ tool }).success).toBe(true);
    }
    expect(ConciergeSettingsSchema.safeParse({ tool: "codex" }).success).toBe(false);
  });

  it("task frontmatter takes draftFor", () => {
    const base = fm();
    expect(
      TaskFrontmatterSchema.safeParse({ ...base, draftFor: { planId: "p-1", planVersion: 3 } })
        .success,
    ).toBe(true);
    expect(
      TaskFrontmatterSchema.safeParse({ ...base, draftFor: { planId: "P 1", planVersion: 3 } })
        .success,
    ).toBe(false);
    expect(
      TaskFrontmatterSchema.safeParse({ ...base, draftFor: { planId: "p", planVersion: 1.5 } })
        .success,
    ).toBe(false);
    expect(TaskFrontmatterSchema.safeParse(base).success).toBe(true);
  });

  const withProfiles = (): Settings => ({
    ...defaultSettings(),
    roles: {
      planner: { tool: "mock", model: "g-plan" },
      developer: { tool: "mock", model: "g-dev" },
      reviewer: { tool: "mock", model: "g-rev" },
    },
    profiles: [
      OrchestrationProfileSchema.parse(profile()),
      OrchestrationProfileSchema.parse(
        profile({
          id: "full",
          name: "Full",
          roles: { planner: A, developer: B, observer: C, reviewer: A },
        }),
      ),
    ],
  });

  it("resolution order: task, project role, profile, global roles", () => {
    const s = withProfiles();
    s.activeProfile = "full";
    const none = newTask(fm());
    // Profile beats the global roles.
    expect(resolveRoleOrOff(s, none, "developer")).toEqual(B);
    expect(resolveRoleOrOff(s, none, "observer")).toEqual(C);
    // Project override beats the profile; profile still applies to the other roles.
    const e = effectiveSettings(s, project({ roles: { developer: A } }));
    expect(resolveRoleOrOff(e, none, "developer")).toEqual(A);
    expect(resolveRoleOrOff(e, none, "reviewer")).toEqual(A);
    // Task beats the project.
    const task = newTask(fm({ tools: { developer: C } }));
    expect(resolveRoleOrOff(e, task, "developer")).toEqual(C);
    // The project's profile beats the active one.
    const p = effectiveSettings(s, project({ profile: "lean" }));
    expect(resolveRoleOrOff(p, none, "developer")).toEqual(B);
    expect(resolveRoleOrOff(p, none, "reviewer")).toBeNull();
    // A project role override still beats the project's profile.
    const both = effectiveSettings(s, project({ profile: "lean", roles: { reviewer: C } }));
    expect(resolveRoleOrOff(both, none, "reviewer")).toEqual(C);
  });

  it("a null profile role is off; a task override can turn it back on", () => {
    const s = withProfiles();
    s.activeProfile = "lean";
    const none = newTask(fm());
    expect(resolveRoleOrOff(s, none, "planner")).toBeNull();
    expect(resolveRoleOrOff(s, none, "reviewer")).toBeNull();
    expect(resolveRoleOrOff(s, none, "observer")).toBeNull();
    const task = newTask(fm({ tools: { planner: A } }));
    expect(resolveRoleOrOff(s, task, "planner")).toEqual(A);
  });

  it("with no profiles, or no active one, resolution is exactly the 0.5.0 order", () => {
    const plain = defaultSettings();
    const t = newTask(fm());
    for (const role of ["planner", "developer", "reviewer"] as const) {
      expect(resolveRoleOrOff(plain, t, role)).toEqual(plain.roles[role]);
      expect(resolveRole(plain, t, role)).toEqual(plain.roles[role]);
    }
    expect(resolveRoleOrOff(plain, t, "observer")).toBeUndefined();
    const idle = withProfiles(); // defined but none active
    expect(resolveRoleOrOff(idle, t, "reviewer")).toEqual(idle.roles.reviewer);
    // An active id that no longer exists falls back to the global roles.
    idle.activeProfile = "gone";
    expect(resolveRoleOrOff(idle, t, "planner")).toEqual(idle.roles.planner);
  });

  it("legacy resolveRole reads an off planner/reviewer as the global role and off observer as unset", () => {
    const s = withProfiles();
    s.activeProfile = "lean";
    const t = newTask(fm());
    expect(resolveRole(s, t, "planner")).toEqual(s.roles.planner);
    expect(resolveRole(s, t, "observer")).toBeUndefined();
    expect(resolveRole(s, t, "developer")).toEqual(B);
  });

  it("checkProfiles: unknown tool, in-use deletion, consistency", () => {
    const current = withProfiles();
    const ctx = {
      knownTools: ["mock"],
      projects: [{ id: "alpha", profile: "lean" }, { id: "beta" }],
    };
    expect(checkProfiles(current, current, ctx)).toBeNull();
    const dropped = { ...current, profiles: current.profiles!.filter((p) => p.id !== "lean") };
    expect(checkProfiles(current, dropped, ctx)).toMatchObject({
      code: "profile_in_use",
      projects: ["alpha"],
    });
    const free = { ...current, profiles: current.profiles!.filter((p) => p.id !== "full") };
    expect(checkProfiles(current, free, ctx)).toBeNull();
    expect(checkProfiles(current, current, { ...ctx, knownTools: ["codex"] })).toMatchObject({
      code: "unknown_tool",
    });
    expect(checkProfiles(current, { ...current, activeProfile: "ghost" }, ctx)).toMatchObject({
      code: "invalid_profiles",
    });
    const dup = { ...current, profiles: [...current.profiles!, current.profiles![0]!] };
    expect(checkProfiles(current, dup, ctx)).toMatchObject({ code: "invalid_profiles" });
  });

  it("the store refuses to save an inconsistent file and keeps profiles across a reload", async () => {
    const store = new SettingsStore(root);
    await expect(store.save({ ...withProfiles(), activeProfile: "ghost" })).rejects.toThrow(
      /activeProfile does not exist/,
    );
    const saved = { ...withProfiles(), activeProfile: "full" };
    await store.save(saved);
    const loaded = await store.load();
    expect(loaded.activeProfile).toBe("full");
    expect(loaded.profiles).toHaveLength(2);
  });
});
