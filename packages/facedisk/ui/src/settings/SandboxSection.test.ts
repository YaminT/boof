import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SandboxPanel, type SandboxView } from "./SandboxSection.js";

const sandbox = { readPaths: ["/usr"], writePaths: [] as string[], denyTcpPorts: [] as number[] };

function render(mode: "off" | "enforce", status: SandboxView): string {
  return renderToStaticMarkup(
    h(SandboxPanel, {
      sandbox: { ...sandbox, mode },
      status,
      onMode: async () => ({ ok: true as const }),
      onSaveLists: async () => {},
    }),
  );
}

describe("SandboxPanel", () => {
  it("shows off, with the switch clear and the three lists", () => {
    const html = render("off", { mode: "off", state: "off", reason: "agents are not sandboxed" });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Off. Agents are not sandboxed.");
    expect(html).toContain("Read-only folders");
    expect(html).toContain("Writable folders");
    expect(html).toContain("Blocked TCP ports");
    expect(html).toContain("/usr");
  });

  it("shows enforce when the self-test passed", () => {
    const html = render("enforce", { mode: "enforce", state: "ok", reason: "" });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("On. The sandbox self-test passed.");
    expect(html).not.toContain("Unavailable.");
  });

  it("keeps enforce on and shows the reason when the self-test did not pass", () => {
    const html = render("enforce", {
      mode: "enforce",
      state: "unavailable",
      reason: "boof-sandbox helper is missing",
    });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Unavailable. boof-sandbox helper is missing");
  });

  it("shows the Landlock ABI upgrade requirement when enforce is unavailable", () => {
    const reason =
      "Landlock ABI 5 does not scope signals; upgrade the kernel to 6.12 or newer (Landlock ABI 6) before enabling enforce";
    const html = render("enforce", { mode: "enforce", state: "unavailable", reason });
    expect(html).toContain(reason);
  });

  it("keeps a passing self-test's kernel note", () => {
    const html = render("enforce", {
      mode: "enforce",
      state: "ok",
      reason: "signals not scoped (kernel older than 6.12)",
    });
    expect(html).toContain(
      "On. The sandbox self-test passed. signals not scoped (kernel older than 6.12)",
    );
  });
});
