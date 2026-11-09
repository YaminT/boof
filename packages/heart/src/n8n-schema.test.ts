import { describe, expect, it } from "vitest";
import {
  ExternalStepSchema,
  N8N_DEFAULT_TIMEOUT_MS,
  N8nSettingsSchema,
  ProjectPatchSchema,
  ProjectSchema,
  SettingsPatchSchema,
  SettingsSchema,
  TaskFrontmatterSchema,
  WEBHOOK_PATH_PATTERN,
} from "./schema.js";

const now = "2026-11-09T10:00:00.000Z";
const step = {
  id: "ci",
  label: "CI",
  at: "after-developer",
  workflowId: "wf1",
  webhookPath: "boof/ci-check",
};
const project = (extra: Record<string, unknown> = {}) => ({
  id: "shop",
  name: "Shop",
  workingDirectory: "/tmp/shop",
  origin: { kind: "ui" },
  created: now,
  updated: now,
  ...extra,
});

describe("n8n schemas", () => {
  it("minimal n8n settings parse and default the timeout to 1_800_000", () => {
    const s = N8nSettingsSchema.parse({
      baseUrl: "http://n8n:5678",
      callbackBaseUrl: "https://b.x",
    });
    expect(s.defaultTimeoutMs).toBe(1_800_000);
    expect(N8N_DEFAULT_TIMEOUT_MS).toBe(1_800_000);
  });

  it("checks defaults", () => {
    const s = N8nSettingsSchema.parse({
      baseUrl: "http://n8n:5678/prefix",
      callbackBaseUrl: "https://b.x/boof",
      checks: { projectId: "shop" },
    });
    expect(s.checks).toEqual({
      enabled: false,
      projectId: "shop",
      autoQueue: false,
      pollIntervalMs: 300_000,
    });
  });

  it("n8n URLs refuse credentials, query, hash and non-http schemes", () => {
    for (const bad of [
      "https://u:p@n8n.x",
      "https://u@n8n.x",
      "https://@n8n.x",
      "https://n8n.x#",
      "https://evil.com\\@n8n.x",
      "https://n8n.x/a/%2e%2e/b",
      " https://n8n.x",
      "https://n8n.x ",
      "https://n8n.x:0",
      "https://n8n.x\t",
      "https://n8n.x/?a=1",
      "https://n8n.x/#h",
      "https://n8n.x?",
      "ftp://n8n.x",
      "not a url",
    ]) {
      expect(
        N8nSettingsSchema.safeParse({ baseUrl: bad, callbackBaseUrl: "https://b.x" }).success,
      ).toBe(false);
      expect(
        N8nSettingsSchema.safeParse({ baseUrl: "https://n8n.x", callbackBaseUrl: bad }).success,
      ).toBe(false);
      expect(
        N8nSettingsSchema.safeParse({
          baseUrl: "https://n8n.x",
          callbackBaseUrl: "https://b.x",
          webhookBaseUrl: bad,
        }).success,
      ).toBe(false);
    }
  });

  it("n8n URLs are stored in canonical form (no trailing slash, prefix kept)", () => {
    const s = N8nSettingsSchema.parse({
      baseUrl: "https://n8n.x/",
      callbackBaseUrl: "https://b.x/boof//",
    });
    expect(s.baseUrl).toBe("https://n8n.x");
    expect(s.callbackBaseUrl).toBe("https://b.x/boof");
  });

  it("timeouts outside 10_000..86_400_000 are refused", () => {
    for (const t of [9_999, 86_400_001]) {
      expect(
        N8nSettingsSchema.safeParse({
          baseUrl: "https://n8n.x",
          callbackBaseUrl: "https://b.x",
          defaultTimeoutMs: t,
        }).success,
      ).toBe(false);
      expect(ExternalStepSchema.safeParse({ ...step, timeoutMs: t }).success).toBe(false);
    }
    expect(ExternalStepSchema.safeParse({ ...step, timeoutMs: 10_000 }).success).toBe(true);
    expect(ExternalStepSchema.safeParse({ ...step, timeoutMs: 86_400_000 }).success).toBe(true);
  });

  it("webhook paths: accepts 'boof/ci-check' and a uuid; refuses '../x', 'a/../b', 'a//b', '/abs', 'a?b', 'a#b', 201 chars", () => {
    for (const ok of [
      "boof/ci-check",
      "3f2b8a1e-9c4d-4e6a-8b7f-0a1b2c3d4e5f",
      "a.b_c~d:e",
      ".x",
      "a/.b/c.",
    ])
      expect(WEBHOOK_PATH_PATTERN.test(ok), ok).toBe(true);
    for (const bad of [
      "../x",
      "a/../b",
      "a//b",
      "/abs",
      "a?b",
      "a#b",
      "a".repeat(201),
      "",
      "a b",
      "a%2e",
      ".",
      "..",
      "./x",
      "a/./b",
      "a/.",
    ])
      expect(WEBHOOK_PATH_PATTERN.test(bad), bad).toBe(false);
    expect(WEBHOOK_PATH_PATTERN.test("a".repeat(200))).toBe(true);
  });

  it("an external step is strict and defaults onFailure and sendDiff", () => {
    const s = ExternalStepSchema.parse(step);
    expect(s.onFailure).toBe("fail");
    expect(s.sendDiff).toBe(false);
    expect(ExternalStepSchema.safeParse({ ...step, extra: 1 }).success).toBe(false);
    expect(ExternalStepSchema.safeParse({ ...step, at: "check" }).success).toBe(false);
    expect(ExternalStepSchema.safeParse({ ...step, workflowId: "a/b" }).success).toBe(false);
    expect(ExternalStepSchema.safeParse({ ...step, label: "   " }).success).toBe(false);
    expect(ExternalStepSchema.safeParse({ ...step, id: "Not Kebab" }).success).toBe(false);
  });

  it("a project with duplicate step ids or 11 steps is refused", () => {
    const dup = ProjectSchema.safeParse(project({ externalSteps: [step, step] }));
    expect(dup.success).toBe(false);
    expect(JSON.stringify(dup.error?.issues)).toContain("duplicate external step id: ci");
    const many = Array.from({ length: 11 }, (_, i) => ({ ...step, id: `s${i}` }));
    expect(ProjectSchema.safeParse(project({ externalSteps: many })).success).toBe(false);
    expect(ProjectSchema.safeParse(project({ externalSteps: many.slice(0, 10) })).success).toBe(
      true,
    );
  });

  it("ProjectPatchSchema accepts externalSteps: null", () => {
    expect(ProjectPatchSchema.safeParse({ externalSteps: null }).success).toBe(true);
    expect(ProjectPatchSchema.safeParse({ externalSteps: [step] }).success).toBe(true);
    expect(ProjectPatchSchema.safeParse({ externalSteps: [step, step] }).success).toBe(false);
  });

  it("an existing project.json without externalSteps round-trips unchanged", () => {
    const raw = project({ paused: false, archived: false, planWriteBack: true, labels: [] });
    const parsed = ProjectSchema.parse(raw);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw);
    expect("externalSteps" in parsed).toBe(false);
  });

  it("settings without n8n parse; SettingsPatchSchema refuses an n8n key", () => {
    const base = {
      schemaVersion: 2,
      runner: { enabled: false, concurrency: 1 },
      roles: {
        planner: { tool: "codex", model: "" },
        developer: { tool: "codex", model: "" },
        observer: { tool: "codex", model: "" },
        reviewer: { tool: "codex", model: "" },
      },
      models: {},
    };
    const parsed = SettingsSchema.safeParse(base);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(
      SettingsSchema.safeParse({
        ...base,
        n8n: { baseUrl: "https://n.x", callbackBaseUrl: "https://b.x" },
      }).success,
    ).toBe(true);
    expect(SettingsPatchSchema.safeParse({ n8n: { baseUrl: "https://n.x" } }).success).toBe(false);
  });

  it("an existing task file without n8nCheck parses; one with it parses", () => {
    const t = {
      id: "t",
      title: "T",
      status: "draft",
      priority: 0,
      skip: false,
      created: now,
      updated: now,
    };
    expect(TaskFrontmatterSchema.safeParse(t).success).toBe(true);
    const c = TaskFrontmatterSchema.safeParse({
      ...t,
      n8nCheck: { workflowId: "w1", workflowName: "Deploy", webhookPath: "p/q", updatedAt: now },
    });
    expect(c.success).toBe(true);
  });
});
