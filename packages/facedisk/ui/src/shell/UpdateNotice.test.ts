import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkForUpdate, type ToolCatalog, type UpdateFetch } from "@boof/heart";
import { TaskService, createApp } from "@boof/heart-server";
import { TEST_LOOPBACK_IS_UI } from "../../../../heart-server/src/server/test-ui-session.js";
import { UpdateNoticeView } from "./UpdateNotice.js";

const notice = {
  version: "0.5.0",
  url: "https://github.com/YaminT/boof/releases/tag/v0.5.0",
};

const catalog = {
  list: () => [],
  get: () => undefined,
  healthAll: async () => ({}),
  lastHealth: () => ({}),
  modelsAll: async () => ({}),
  cachedModels: () => ({}),
  cachedLiveModels: () => ({}),
} satisfies ToolCatalog;

describe("UpdateNoticeView", () => {
  it("shows one line with a link to the release, and nothing when there is no notice", () => {
    expect(renderToStaticMarkup(h(UpdateNoticeView, { notice: null, onDismiss: () => {} }))).toBe(
      "",
    );
    const html = renderToStaticMarkup(h(UpdateNoticeView, { notice, onDismiss: () => {} }));
    expect(html).toContain("New version available");
    expect(html).toContain(`href="${notice.url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">0.5.0<");
    expect(html).toContain("Dismiss");
    expect(html).toContain('type="button"');
  });

  it("a scratch server with a fake release shows the line and hides it after dismissal", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-updates-http-"));
    const calls: string[] = [];
    const fetchImpl: UpdateFetch = async (url) => {
      calls.push(url);
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            tag_name: "v0.5.0",
            html_url: notice.url,
            prerelease: false,
            draft: false,
          }),
      };
    };
    try {
      await checkForUpdate({ root, version: "0.4.0", fetchImpl, env: {} });
      expect(calls).toHaveLength(1);
      const app = createApp({
        browserSessions: TEST_LOOPBACK_IS_UI,
        service: new TaskService(root, catalog),
        peerAddress: () => "127.0.0.1",
        version: "0.4.0",
      });
      const req = (path: string, init?: RequestInit) =>
        app.request("http://localhost" + path, init);
      const shown = await req("/api/v1/updates");
      expect(shown.status).toBe(200);
      const body = (await shown.json()) as { update: typeof notice | null };
      expect(body).toEqual({ update: notice });
      const html = renderToStaticMarkup(
        h(UpdateNoticeView, { notice: body.update, onDismiss: () => {} }),
      );
      expect(html).toContain("New version available");
      expect(html).toContain(`href="${notice.url}"`);
      expect(html).toContain(">0.5.0<");

      const bad = await req("/api/v1/updates/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "../nope" }),
      });
      expect(bad.status).toBe(400);
      expect(await (await req("/api/v1/updates")).json()).toEqual(body);

      const hidden = await req("/api/v1/updates/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.5.0" }),
      });
      expect(hidden.status).toBe(200);
      expect(await hidden.json()).toEqual({ update: null });
      expect(renderToStaticMarkup(h(UpdateNoticeView, { notice: null, onDismiss: () => {} }))).toBe(
        "",
      );
      expect(await (await req("/api/v1/updates")).json()).toEqual({ update: null });
      expect(calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
