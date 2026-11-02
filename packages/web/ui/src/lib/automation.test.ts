import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { commandIdFor, inputErrorLines, parseEvents, webhookFormProblems } from "./automation.js";

describe("commandIdFor", () => {
  it("derives a kebab id", () => {
    expect(commandIdFor("Secure  Feature_v2!")).toBe("secure-feature-v2");
  });
});

describe("parseEvents", () => {
  it("splits on commas and spaces and drops duplicates", () => {
    expect(parseEvents("task.*, plan.*  task.*")).toEqual(["task.*", "plan.*"]);
  });
  it("means every event when empty", () => {
    expect(parseEvents(" ")).toEqual(["*"]);
  });
});

describe("webhookFormProblems", () => {
  const ok = { url: "https://example.com/hook", events: "task.*", projects: "*" as const };
  it("accepts a valid form", () => {
    expect(webhookFormProblems(ok)).toEqual([]);
    expect(webhookFormProblems({ ...ok, events: "" })).toEqual([]);
  });
  it("flags a non-http URL, an event the server refuses and an empty project list", () => {
    expect(webhookFormProblems({ ...ok, url: "ftp://x" })).toEqual([
      "Enter a URL that starts with http:// or https://.",
    ]);
    // The server's pattern has no underscore (see the goal webhook-update-and-event-names).
    expect(webhookFormProblems({ ...ok, events: "runner.budget_exceeded" })).toEqual([
      "Use event types such as task.status or patterns such as plan.*.",
    ]);
    expect(webhookFormProblems({ ...ok, projects: [] })).toEqual([
      "Choose at least one project, or send events from every project.",
    ]);
  });
});

describe("inputErrorLines", () => {
  it("lists validation details", () => {
    const err = new ApiError("bad", 400, "invalid_input", [
      { path: "url", message: "Must be http(s)" },
    ]);
    expect(inputErrorLines(err)).toEqual(["url: Must be http(s)"]);
  });
  it("falls back to the message", () => {
    expect(inputErrorLines(new Error("boom"))).toEqual(["boom"]);
    expect(inputErrorLines(new ApiError("nope", 403, "forbidden"))).toEqual(["nope"]);
  });
});
