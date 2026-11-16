import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOPBAR_TONES, contrast } from "./topbar.js";

const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

/** The `--tb-*` custom properties declared in the first block that starts with `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--(tb-[a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) out[m[1]] = m[2];
  return out;
}

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
])("topbar tokens (%s)", (_theme, selector) => {
  const t = tokens(selector);
  it.each(TOPBAR_TONES)("%s defines all four tokens", (tone) => {
    for (const part of ["bg", "border", "fg", "dot"]) expect(t[`tb-${tone}-${part}`]).toBeDefined();
  });
  it.each(TOPBAR_TONES)("%s text meets WCAG AA on its tint", (tone) => {
    expect(contrast(t[`tb-${tone}-fg`], t[`tb-${tone}-bg`])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(TOPBAR_TONES)("%s dot and accent are visible on the tint (3:1)", (tone) => {
    expect(contrast(t[`tb-${tone}-dot`], t[`tb-${tone}-bg`])).toBeGreaterThanOrEqual(3);
  });
});
