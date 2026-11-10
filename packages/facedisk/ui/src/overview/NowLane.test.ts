import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRefusal } from "./AgentRefusal.js";
import { SteerModelSelect } from "./SteerModelSelect.js";

describe("AgentRefusal (Now lane)", () => {
  it("shows the refusal reason, and nothing without one", () => {
    expect(renderToStaticMarkup(h(AgentRefusal, { reason: null }))).toBe("");
    const html = renderToStaticMarkup(
      h(AgentRefusal, {
        reason: "claude-agent cannot start: subscription accounts stay on claude-code.",
      }),
    );
    expect(html).toContain("Queued claude-agent tasks are waiting");
    expect(html).toContain("subscription accounts stay on claude-code.");
  });
});

describe("SteerModelSelect (inject dialog)", () => {
  const props = { choices: ["default", "opus"], value: "", onChange: () => {} };
  it("offers Switch model with mode now", () => {
    const html = renderToStaticMarkup(h(SteerModelSelect, { ...props, mode: "now" }));
    expect(html).toContain("Switch model");
    expect(html).toContain("Keep the current model");
    expect(html).toContain('<option value="opus">opus</option>');
  });
  it("has no model option for the next step, or when the tool has no models to switch to", () => {
    expect(renderToStaticMarkup(h(SteerModelSelect, { ...props, mode: "next-step" }))).toBe("");
    expect(renderToStaticMarkup(h(SteerModelSelect, { ...props, mode: "now", choices: [] }))).toBe(
      "",
    );
  });
});
