import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Settings } from "@boof/heart/schema";
import { AccountsPage } from "./AccountsPage.js";

const form = { enabled: false, url: "http://127.0.0.1:8080", healthGate: "pause" as const };
const render = (settings: Partial<Settings>) =>
  renderToStaticMarkup(
    h(AccountsPage, {
      settings: settings as Settings,
      onChanged: async () => {},
      advancedOpen: false,
      form,
      setForm: () => {},
    }),
  );

describe("AccountsPage by pool mode", () => {
  it("keeps the better-ccflare view when gateway is absent and owlish is set", () => {
    const html = render({ owlish: { url: "http://127.0.0.1:8080", healthGate: "pause" } });
    expect(html).toContain("Gateway URL");
    expect(html).toContain("Client key");
    expect(html).toContain("Agent key");
    expect(html).toContain("better-ccflare dashboard");
    expect(html).toContain("Account pooling by");
    expect(html).not.toContain("Add account");
    expect(html).not.toContain("Anthropic API keys only");
  });
  it("keeps today's unconfigured page when nothing is set", () => {
    const html = render({});
    expect(html).toContain("No gateway configured.");
  });
  it("shows the internal view with the add form and the terms note, without better-ccflare fields", () => {
    const html = render({ gateway: { mode: "internal" } });
    expect(html).toContain("Account pool mode");
    // The add form needs write access, which the page learns after whoami resolves.
    expect(html).toContain("Anthropic API keys only");
    expect(html).toContain("Strategy");
    expect(html).not.toContain("Gateway URL");
    expect(html).not.toContain("Client key");
    expect(html).not.toContain("better-ccflare dashboard");
    expect(html).not.toContain("Account pooling by");
  });
  it("shows only a note when the mode is explicitly none", () => {
    const html = render({
      gateway: { mode: "none" },
      owlish: { url: "http://127.0.0.1:8080", healthGate: "pause" },
    });
    expect(html).toContain("No account pool. Agents use their own sign-in.");
    expect(html).not.toContain("Gateway URL");
  });
});
