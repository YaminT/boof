import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { ERROR_CODES, registry, TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";
import { HARNESS_MD } from "./generated/harness.js";
import {
  embeddedModule,
  expectedHarnessMd,
  HARNESS_MD as HARNESS_MD_PATH,
  HARNESS_TS,
} from "../../../scripts/gen-harness-reference.js";

const UPDATE = process.env["UPDATE_HARNESS_DOCS"] === "1";

describe("the generated harness guide", () => {
  it("has an up-to-date reference section and embedded copy (UPDATE_HARNESS_DOCS=1 rewrites them)", async () => {
    const current = await readFile(HARNESS_MD_PATH, "utf8");
    const expected = await expectedHarnessMd(current);
    if (UPDATE) {
      await writeFile(HARNESS_MD_PATH, expected);
      await writeFile(HARNESS_TS, embeddedModule(expected));
    }
    expect(UPDATE ? expected : current).toBe(expected);
    expect(await readFile(HARNESS_TS, "utf8")).toBe(embeddedModule(expected));
    expect(HARNESS_MD).toBe(expected);
  });

  it("documents every operation, MCP tool and error code", () => {
    for (const op of registry) {
      expect(HARNESS_MD, op.name).toContain(`\`${op.rest.method} /api/v1${op.rest.path}\``);
      if (op.mcp.expose) expect(HARNESS_MD, op.name).toContain(`\`${op.mcp.name}\``);
    }
    for (const code of Object.keys(ERROR_CODES)) {
      expect(HARNESS_MD, code).toMatch(new RegExp(`^\\| \`${code}\``, "m"));
    }
  });

  it("starts the connection steps with section 1", () => {
    expect(HARNESS_MD).toContain("## 1. Ask the user for connection details");
    expect(HARNESS_MD).not.toContain("{{BOOF_URL}}");
  });
});

describe("public docs routes", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "boof-harness-"));
    const settings = defaultSettings();
    settings.security = {
      allowedHosts: [],
      auth: { mode: "required" },
      allowedProjectRoots: [],
      externalTasksRequireApproval: true,
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30 },
      audit: { enabled: true, retentionDays: 90 },
    };
    await new SettingsStore(root).save(settings);
    // A remote peer: no local trust, so any 200 below proves the routes need no key.
    app = createApp({ service: new TaskService(root), peerAddress: () => "10.1.2.3" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request("http://localhost" + path, { headers });

  it("serves /harness.md and /harness.txt without a key, even in required mode", async () => {
    const md = await get("/harness.md");
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const txt = await get("/harness.txt");
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await txt.text();
    expect(body).toBe(HARNESS_MD);
    expect(body).toContain("## 1.");
    expect(await md.text()).toBe(HARNESS_MD);
    // The API itself still needs a key.
    expect((await get("/api/v1/whoami")).status).toBe(401);
  });

  it("serves /llms.txt pointing at the guide and the OpenAPI document", async () => {
    const res = await get("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.startsWith("# boof-runner")).toBe(true);
    expect(body).toContain("(/harness.txt)");
    expect(body).toContain("(/api/v1/openapi.json)");
  });

  it("still applies the Host guard and the security headers", async () => {
    const bad = await get("/harness.txt", { host: "evil.example" });
    expect(bad.status).toBe(421);
    const ok = await get("/harness.txt");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
