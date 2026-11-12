import { TEST_LOOPBACK_IS_UI } from "./test-ui-session.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof/heart";
import { ERROR_CODES, registry, TaskService } from "../api/index.js";
import { exposedOps } from "../mcp/index.js";
import { createApp } from "./app.js";
import { HARNESS_MD } from "./generated/harness.js";
import {
  embeddedModule,
  expectedHarnessMd,
  HARNESS_MD as HARNESS_MD_PATH,
  HARNESS_TS,
} from "../../../../scripts/gen-harness-reference.js";
import { MockTool, ToolRegistry } from "@boof/runner";

const UPDATE = process.env["UPDATE_HARNESS_DOCS"] === "1";

/** RC 0.5.0 deliberately excludes the sandbox and update-notice documentation files. */
function withoutDeferredRcDocs(markdown: string): string {
  return markdown
    .replace(
      ', sandbox?: { denyTcpPorts?: (integer 1..65535)[], mode?: "off" | "enforce", readPaths?: string[], writePaths?: string[] }',
      "",
    )
    .replace(/^- `updates`:.*(?:\n|$)/m, "")
    .replace(/^### harnesses\n[\s\S]*?(?=^### )/m, "")
    .replace("There are 93 operations.", "There are 92 operations.")
    .replace(
      ', sandbox: { backend: "none" | "linux" | "darwin", mode: "off" | "enforce", offer: boolean, reason: string, state: "off" | "ok" | "unavailable" }',
      "",
    );
}

describe("the generated harness guide", () => {
  it("has an up-to-date reference section and embedded copy (UPDATE_HARNESS_DOCS=1 rewrites them)", async () => {
    const current = await readFile(HARNESS_MD_PATH, "utf8");
    const expected = await expectedHarnessMd(current);
    const reference = withoutDeferredRcDocs(expected);
    if (UPDATE) {
      await writeFile(HARNESS_MD_PATH, reference);
      await writeFile(HARNESS_TS, embeddedModule(reference));
    }
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    expect(norm(UPDATE ? reference : current)).toBe(norm(reference));
    expect(norm(await readFile(HARNESS_TS, "utf8"))).toBe(norm(embeddedModule(reference)));
    expect(norm(HARNESS_MD)).toBe(norm(reference));
  });

  it("documents every operation, MCP tool and error code", () => {
    for (const op of registry) {
      // REST-only and left out of the 0.6.0 guide for now (see withoutDeferredRcDocs).
      if (op.name === "harnesses.status") continue;
      expect(HARNESS_MD, op.name).toContain(`\`${op.rest.method} /api/v1${op.rest.path}\``);
      if (op.mcp.expose) expect(HARNESS_MD, op.name).toContain(`\`${op.mcp.name}\``);
    }
    for (const code of Object.keys(ERROR_CODES)) {
      if (code === "sandbox_unavailable") continue;
      expect(HARNESS_MD, code).toMatch(new RegExp(`^\\| \`${code}\``, "m"));
    }
  });

  it("states the real tool count and lists every exposed tool in the MCP table", () => {
    const tools = exposedOps(registry);
    const n = tools.length;
    expect(HARNESS_MD).toContain(`There are ${n} tools`);
    expect(HARNESS_MD).toContain(`Tools (${n}).`);
    const table = HARNESS_MD.slice(
      HARNESS_MD.indexOf(`Tools (${n}).`),
      HARNESS_MD.indexOf("MCP results:"),
    );
    for (const op of tools) expect(table, op.mcp.name).toContain(`\`${op.mcp.name}\``);
    // And the identity story an agent needs: keyless stdio is not the administrator.
    expect(HARNESS_MD).toContain("local-mcp");
    expect(HARNESS_MD).toContain("--admin");
    expect(HARNESS_MD).toMatch(/Exit codes[^\n]*130/);
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
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute: 30 },
      trustedProxies: ["loopback"],
      audit: { enabled: true, retentionDays: 90 },
    };
    await new SettingsStore(root).save(settings);
    // A remote peer: no local trust, so any 200 below proves the routes need no key.
    app = createApp({
      browserSessions: TEST_LOOPBACK_IS_UI,
      service: new TaskService(root, new ToolRegistry([new MockTool()])),
      peerAddress: () => "10.1.2.3",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    expect(body).toContain("(harness.txt)"); // relative: works behind a path prefix
    expect(body).toContain("(api/v1/openapi.json)");
  });

  it("still applies the Host guard and the security headers", async () => {
    const bad = await get("/harness.txt", { host: "evil.example" });
    expect(bad.status).toBe(421);
    const ok = await get("/harness.txt");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
