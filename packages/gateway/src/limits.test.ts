import { describe, expect, it } from "vitest";
import { classify, DEFAULT_RESET_MS, MAX_RESET_MS, parseRetryAfter } from "./limits.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const body = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message } });

describe("classify", () => {
  it("treats 2xx as ok", () => {
    expect(classify({ status: 200 }, NOW)).toEqual({ kind: "ok" });
  });

  it("429 uses retry-after seconds", () => {
    expect(classify({ status: 429, headers: { "Retry-After": "30" } }, NOW)).toEqual({
      kind: "rate_limited",
      until: NOW + 30_000,
    });
  });

  it("429 uses an HTTP-date retry-after", () => {
    const date = new Date(NOW + 90_000).toUTCString();
    expect(classify({ status: 429, headers: { "retry-after": date } }, NOW)).toEqual({
      kind: "rate_limited",
      until: NOW + 90_000,
    });
  });

  it("429 falls back to the latest ratelimit reset header", () => {
    const headers = new Headers({
      "anthropic-ratelimit-requests-reset": new Date(NOW + 10_000).toISOString(),
      "anthropic-ratelimit-tokens-reset": new Date(NOW + 45_000).toISOString(),
      "anthropic-ratelimit-input-tokens-reset": "garbage",
    });
    expect(classify({ status: 429, headers }, NOW)).toEqual({
      kind: "rate_limited",
      until: NOW + 45_000,
    });
  });

  it("429 with missing or garbled headers waits 60 s", () => {
    const want = { kind: "rate_limited", until: NOW + DEFAULT_RESET_MS };
    expect(classify({ status: 429 }, NOW)).toEqual(want);
    expect(classify({ status: 429, headers: { "retry-after": "soon" } }, NOW)).toEqual(want);
    expect(
      classify(
        { status: 429, headers: { "retry-after": new Date(NOW - 5000).toUTCString() } },
        NOW,
      ),
    ).toEqual(want);
  });

  it("caps an absurd reset", () => {
    expect(classify({ status: 429, headers: { "retry-after": "99999999" } }, NOW)).toEqual({
      kind: "rate_limited",
      until: NOW + MAX_RESET_MS,
    });
  });

  it("401 and 403 are auth faults", () => {
    expect(classify({ status: 401 }, NOW)).toEqual({ kind: "auth" });
    expect(classify({ status: 403, body: body("permission_error", "no") }, NOW)).toEqual({
      kind: "auth",
    });
  });

  it("a low credit balance or spend limit is a credit fault", () => {
    const msg = "Your credit balance is too low to access the Anthropic API.";
    expect(classify({ status: 400, body: body("invalid_request_error", msg) }, NOW)).toEqual({
      kind: "credit",
    });
    expect(classify({ status: 400, body: body("x", "You reached your Spend Limit") }, NOW)).toEqual(
      {
        kind: "credit",
      },
    );
    expect(classify({ status: 402, body: body("billing_error", "pay") }, NOW)).toEqual({
      kind: "credit",
    });
  });

  it("529, 5xx and overloaded are not account faults", () => {
    expect(classify({ status: 529, body: body("overloaded_error", "busy") }, NOW)).toEqual({
      kind: "transient",
    });
    expect(classify({ status: 500 }, NOW)).toEqual({ kind: "transient" });
    expect(classify({ status: 400, body: body("overloaded_error", "busy") }, NOW)).toEqual({
      kind: "transient",
    });
  });

  it("other 4xx are request problems, not account faults", () => {
    expect(classify({ status: 400, body: body("invalid_request_error", "bad") }, NOW)).toEqual({
      kind: "other",
    });
    expect(classify({ status: 404, body: "not json" }, NOW)).toEqual({ kind: "other" });
  });
});

describe("parseRetryAfter", () => {
  it("rejects empty and negative values", () => {
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("  ", NOW)).toBeUndefined();
    expect(parseRetryAfter("-5", NOW)).toBeUndefined();
  });
});
