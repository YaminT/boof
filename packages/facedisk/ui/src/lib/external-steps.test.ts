import { describe, expect, it } from "vitest";
import type { N8nInfo, N8nWorkflowSummary, N8nWorkflowsResult } from "../api-types.js";
import {
  moveStep,
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
