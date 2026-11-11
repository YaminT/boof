import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SandboxNotice } from "./SandboxNotice.js";

describe("SandboxNotice", () => {
  it("is one line with Turn on and Dismiss", () => {
    const html = renderToStaticMarkup(
      h(SandboxNotice, { onTurnOn: () => {}, onDismiss: () => {} }),
    );
    expect(html).toContain("Agents are not sandboxed.");
    expect(html).toContain("Turn on");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain('role="alert"');
  });

  it("shows the reason when turning on is refused", () => {
    const html = renderToStaticMarkup(
      h(SandboxNotice, {
        onTurnOn: () => {},
        onDismiss: () => {},
        failure: "landlock abi 3 is below 4",
      }),
    );
    expect(html).toContain("landlock abi 3 is below 4");
  });
});
