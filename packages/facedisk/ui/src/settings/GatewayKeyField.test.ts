import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENT_KEY_HINT, GatewayKeyField } from "./GatewayKeyField.js";

const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    h(GatewayKeyField, {
      label: "Agent key",
      noun: "Agent key",
      source: null,
      value: "",
      onChange: () => {},
      disabled: false,
      hint: AGENT_KEY_HINT,
      ...over,
    }),
  );

describe("GatewayKeyField (Accounts tab agent key)", () => {
  it("is an empty write-only password field with the one-line explanation", () => {
    const html = render();
    expect(html).toContain("Agent key (write only)");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('placeholder="Optional agent key"');
    expect(html).toContain(
      "An api-only better-ccflare key for claude-agent. boof keeps the admin client key to itself.",
    );
    expect(html).not.toContain("Agent key: set");
  });
  it("says only that a key is set and never shows a value", () => {
    const html = render({ source: "file" });
    expect(html).toContain("Agent key: set (file)");
    expect(html).toContain('placeholder="Key is set; enter to replace"');
    expect(html).toContain('value=""');
  });
});
