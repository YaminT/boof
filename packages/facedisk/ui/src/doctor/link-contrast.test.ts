import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LINK } from "./CheckRows.js";

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");

/** The custom properties of one block (`:root` or `.dark`). */
function vars(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("Doctor link style", () => {
  it("uses the brand link token, underlined, with a visible focus ring", () => {
    expect(LINK).toMatch(/(^| )text-accent-brand( |$)/);
    // `text-accent` is the faint tint used for hover backgrounds, not a text colour.
    expect(LINK).not.toMatch(/(^| )text-accent( |$)/);
    expect(LINK).toContain("underline");
    expect(LINK).toContain("focus-visible:outline-2");
    expect(LINK).toContain("focus-visible:outline-accent-brand");
  });

  for (const [theme, selector] of [
    ["light", ":root"],
    ["dark", ".dark"],
  ] as const) {
    it(`meets WCAG AA (4.5:1) on the surface and the page in the ${theme} theme`, () => {
      const base = vars(":root");
      const t = { ...base, ...vars(selector) };
      expect(ratio(t["accent-brand"]!, t["surface"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t["accent-brand"]!, t["page"]!)).toBeGreaterThanOrEqual(4.5);
      // The focus ring is a UI component: 3:1.
      expect(ratio(t["accent-brand"]!, t["surface"]!)).toBeGreaterThanOrEqual(3);
    });
  }
});
