import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SandboxFailure } from "./SandboxFailure.js";

const log = "### Not started\nsandbox_unavailable: helper is missing\n";

describe("SandboxFailure", () => {
  it("shows the reason and a link to the sandbox setting when the task failed", () => {
    const html = renderToStaticMarkup(h(SandboxFailure, { pid: "alpha", status: "failed", log }));
    expect(html).toContain(
      "This task did not start because the sandbox is not available: helper is missing.",
    );
    expect(html).toContain('href="p/alpha/settings/agents#sandbox"');
    expect(html).toContain("Open the sandbox setting");
  });

  it("stays quiet when the task is not failed, even if the log still has the line", () => {
    const html = renderToStaticMarkup(h(SandboxFailure, { pid: "alpha", status: "done", log }));
    expect(html).toBe("");
  });

  it("stays quiet when a failed task failed for another reason", () => {
    const html = renderToStaticMarkup(
      h(SandboxFailure, { pid: "alpha", status: "failed", log: "ERROR: tool failed" }),
    );
    expect(html).toBe("");
  });
});
