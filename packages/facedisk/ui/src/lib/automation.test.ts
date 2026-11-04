import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import {
  canChangeTemplates,
  commandIdFor,
  inputErrorLines,
  parseEvents,
  sameProjects,
  templateFormProblems,
  webhookFormProblems,
} from "./automation.js";

describe("commandIdFor", () => {
  it("derives a kebab id", () => {
    expect(commandIdFor("Secure  Feature_v2!")).toBe("secure-feature-v2");
  });
  it("is the server's rule: accents fold and an empty result falls back to command", () => {
    expect(commandIdFor("Café Déjà vu")).toBe("cafe-deja-vu");
    expect(commandIdFor("!!!")).toBe("command");
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
    expect(webhookFormProblems({ ...ok, events: "runner.budget_exceeded" })).toEqual([]);
    for (const events of ["runner._x", "Runner.enabled", "runner.budget__exceeded", "a b"]) {
      expect(webhookFormProblems({ ...ok, events: events === "a b" ? "ok.* ?x" : events })).toEqual(
        ["Use event types such as task.status or patterns such as plan.*."],
      );
    }
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

describe("webhook form for a restricted caller", () => {
  const ok = { url: "https://example.com/hook", events: "task.*" };
  it("refuses every project and projects outside the caller's reach", () => {
    expect(webhookFormProblems({ ...ok, projects: "*" }, ["alpha"])).toEqual([
      "Your own key cannot send events from every project.",
    ]);
    expect(webhookFormProblems({ ...ok, projects: ["alpha", "beta"] }, ["alpha"])).toEqual([
      "Your own key cannot reach: beta.",
    ]);
    expect(webhookFormProblems({ ...ok, projects: ["alpha"] }, ["alpha"])).toEqual([]);
    expect(webhookFormProblems({ ...ok, projects: "*" }, null)).toEqual([]);
  });
});

describe("template form", () => {
  it("flags an id that is already taken, except the one being edited", () => {
    expect(templateFormProblems("Secure Feature", ["secure-feature"], null)).toEqual([
      "A template with this id exists.",
    ]);
    expect(templateFormProblems("Secure Feature", ["secure-feature"], "secure-feature")).toEqual(
      [],
    );
    expect(templateFormProblems("Other", ["secure-feature"], "secure-feature")).toEqual([]);
    expect(templateFormProblems("Secure Feature", ["secure-feature", "x"], "x")).toEqual([
      "A template with this id exists.",
    ]);
    expect(templateFormProblems(" ", [], null)).toEqual(["Name the template."]);
  });
});

describe("canChangeTemplates", () => {
  const w = (kind: string, trust: string, projects: unknown) =>
    ({ principal: { kind, trust, projects } }) as never;
  it("only the local principal or a trusted unrestricted key", () => {
    expect(canChangeTemplates(null)).toBe(true);
    expect(canChangeTemplates(w("local", "trusted", "*"))).toBe(true);
    expect(canChangeTemplates(w("client", "trusted", "*"))).toBe(true);
    expect(canChangeTemplates(w("client", "review", "*"))).toBe(false);
    expect(canChangeTemplates(w("client", "trusted", ["a"]))).toBe(false);
  });
});

describe("sameProjects", () => {
  it("ignores order and tells * from a list", () => {
    expect(sameProjects(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameProjects("*", "*")).toBe(true);
    expect(sameProjects("*", ["a"])).toBe(false);
    expect(sameProjects(["a"], ["a", "b"])).toBe(false);
  });
});
