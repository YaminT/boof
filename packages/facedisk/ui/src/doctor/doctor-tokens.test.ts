import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast } from "../lib/topbar.js";

const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

/** The hex custom properties of the first block that starts with `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1]!, m[2]!]),
  );
}

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
])("Doctor card colours (%s)", (_theme, selector) => {
  const t = { ...tokens(":root"), ...tokens(selector) } as Record<string, string>;
  const AA = 4.5;
  it("ok card: text, muted text and icon on the surface", () => {
    expect(contrast(t["ink"]!, t["surface"]!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t["ink-muted"]!, t["surface"]!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t["tb-working-fg"]!, t["tb-working-bg"]!)).toBeGreaterThanOrEqual(AA);
  });
  it.each(["paused", "blocked"])("%s card, chip and icon text meet AA", (tone) => {
    const fg = t[`tb-${tone}-fg`]!;
    expect(contrast(fg, t[`tb-${tone}-bg`]!)).toBeGreaterThanOrEqual(AA);
    // The icon sits on the surface inside the tinted card.
    expect(contrast(fg, t["surface"]!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t[`tb-${tone}-dot`]!, t[`tb-${tone}-bg`]!)).toBeGreaterThanOrEqual(3);
  });
  it("optional chip (muted text, transparent on the surface) and its dot", () => {
    expect(contrast(t["ink-muted"]!, t["surface"]!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t["ink-muted"]!, t["page"]!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t["tb-idle-dot"]!, t["surface"]!)).toBeGreaterThanOrEqual(3);
  });
  it("ok chip dot is visible on the surface", () => {
    expect(contrast(t["done"]!, t["surface"]!)).toBeGreaterThanOrEqual(3);
  });
});
