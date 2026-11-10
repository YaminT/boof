import { describe, expect, it } from "vitest";
import type { N8nInfo, N8nWorkflowSummary, N8nWorkflowsResult } from "../api-types.js";
import {
  moveStep,
  n8nEditorHref,
  n8nStatusLine,
  stepDraftErrors,
  usableWebhooks,
  type ExternalStepDraft,
} from "./external-steps.js";

const wf = (webhooks: N8nWorkflowSummary["webhooks"]): N8nWorkflowSummary => ({
  id: "w1",
  name: "Lint",
  active: true,
  updatedAt: "2026-11-09T10:00:00.000Z",
  tags: [],
  webhooks,
  editorUrl: "http://n8n/workflow/w1",
});

/** A host-only cookie is sent to every port of that exact host and to no other host. */
function hostOnlyCookieSent(cookieHost: string, target: string): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");
  return bare(new URL(target).hostname) === bare(cookieHost);
}

describe("n8n editor link", () => {
  it("does not carry a 127.0.0.1 boof cookie to n8n", () => {
    const editor = "http://127.0.0.1:5678/workflow/w1?x=1#flow";
    expect(hostOnlyCookieSent("127.0.0.1", editor)).toBe(true);
    const href = n8nEditorHref(editor, "127.0.0.1");
    expect(hostOnlyCookieSent("127.0.0.1", href)).toBe(false);
    const url = new URL(href);
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("5678");
    expect(url.pathname).toBe("/workflow/w1");
    expect(url.search).toBe("?x=1");
    expect(url.hash).toBe("#flow");
  });

  it("does not carry a localhost boof cookie, and leaves a link that is already a different host", () => {
    const same = n8nEditorHref("http://localhost:5678/workflow/w1", "localhost");
    expect(new URL(same).hostname).toBe("127.0.0.1");
    expect(hostOnlyCookieSent("localhost", same)).toBe(false);
    const other = "http://127.0.0.1:5678/workflow/w1";
    expect(n8nEditorHref(other, "localhost")).toBe(other);
    expect(hostOnlyCookieSent("localhost", other)).toBe(false);
    const v6 = n8nEditorHref("http://[::1]:5678/workflow/w1", "::1");
    expect(new URL(v6).hostname).toBe("localhost");
    expect(hostOnlyCookieSent("::1", v6)).toBe(false);
  });
});

describe("usableWebhooks", () => {
  it("keeps only the POST webhooks marked usable; a GET-only workflow has none", () => {
    expect(usableWebhooks(wf([{ path: "a", method: "POST", usable: true }]))).toHaveLength(1);
    expect(usableWebhooks(wf([{ path: "a", method: "GET", usable: false }]))).toEqual([]);
    expect(usableWebhooks(wf([]))).toEqual([]);
  });
});

describe("stepDraftErrors", () => {
  const ok = (key: string, label: string): ExternalStepDraft => ({
    key,
    label,
    workflowId: "w1",
    webhookPath: "hook",
  });
  it("accepts a valid list", () => {
    expect(stepDraftErrors([ok("a", "Lint"), ok("b", "Deploy")])).toEqual({});
  });
  it("flags a duplicate id, by index of the later row", () => {
    const errs = stepDraftErrors([ok("a", "Lint"), ok("b", "lint")]);
    expect(errs[1]).toMatch(/same id/i);
    expect(errs[0]).toBeUndefined();
  });
  it("uses a saved row's own id", () => {
    const saved: ExternalStepDraft = { ...ok("a", "Other"), id: "lint" };
    expect(stepDraftErrors([saved, ok("b", "Lint")])[1]).toMatch(/same id/i);
  });
  it("flags a missing workflow, a missing webhook and a missing label", () => {
    expect(stepDraftErrors([{ key: "a", label: "X" }])[0]).toMatch(/workflow/i);
    expect(stepDraftErrors([{ key: "a", label: "X", workflowId: "w1" }])[0]).toMatch(/webhook/i);
    expect(stepDraftErrors([{ key: "a", workflowId: "w1", webhookPath: "h" }])[0]).toMatch(
      /label/i,
    );
  });
});

describe("moveStep", () => {
  it("moves without mutating, and ignores out-of-range targets", () => {
    const a = [1, 2, 3];
    expect(moveStep(a, 0, 2)).toEqual([2, 3, 1]);
    expect(a).toEqual([1, 2, 3]);
    expect(moveStep(a, 0, -1)).toEqual([1, 2, 3]);
    expect(moveStep(a, 1, 3)).toEqual([1, 2, 3]);
  });
});

describe("n8nStatusLine", () => {
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const info = (o: Partial<N8nInfo>): N8nInfo => ({
    configured: true,
    baseUrl: "http://localhost:5678",
    apiKeySet: true,
    apiKeySource: "file",
    webhookSecretSet: true,
    ...o,
  });
  const cache = (o: Partial<N8nWorkflowsResult>): N8nWorkflowsResult => ({
    configured: true,
    fetchedAt: "2026-11-09T11:55:00.000Z",
    workflows: [wf([]), wf([])],
    ...o,
  });
  it("not connected", () => {
    expect(
      n8nStatusLine({ ...info({}), configured: false }, cache({ configured: false }), now),
    ).toBe("Not connected");
  });
  it("connected", () => {
    expect(n8nStatusLine(info({}), cache({}), now)).toBe(
      "Connected to localhost:5678 · 2 workflows · refreshed 5m ago",
    );
    expect(n8nStatusLine(info({}), cache({ workflows: [wf([])] }), now)).toContain("1 workflow ·");
  });
  it("never refreshed", () => {
    expect(n8nStatusLine(info({}), cache({ fetchedAt: null, workflows: [] }), now)).toBe(
      "Connected to localhost:5678 · 0 workflows · not refreshed yet",
    );
  });
  it("last refresh failed", () => {
    expect(n8nStatusLine(info({}), cache({ lastError: "unauthorized" }), now)).toBe(
      "Last refresh failed: unauthorized",
    );
  });
});
