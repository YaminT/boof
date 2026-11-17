import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddAccountForm } from "./AddAccountForm.js";

describe("AddAccountForm", () => {
  it("renders a name field and a write-only, empty password key field", () => {
    const html = renderToStaticMarkup(
      h(AddAccountForm, { disabled: false, onAdd: async () => {} }),
    );
    expect(html).toContain("Account name");
    expect(html).toContain("Anthropic API key (write only)");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('placeholder="sk-ant-api..."');
    expect(html).toContain('value=""');
    expect(html).toContain("Add account");
  });
});
