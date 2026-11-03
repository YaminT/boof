import { describe, expect, it } from "vitest";
import type { TaskView } from "../api.js";
import { overviewParts } from "./focus-views.js";

const t = (id: string, status: string) => ({ frontmatter: { id, status } }) as unknown as TaskView;
const recent = [t("a", "done"), t("b", "failed"), t("c", "stopped"), t("d", "done")];

describe("overviewParts", () => {
  it("expanded shows everything", () => {
    expect(overviewParts(true, recent, false)).toEqual({
      recent,
      showRecent: true,
      showSpend: true,
    });
  });
  it("simple keeps only what went wrong from Recent, and spend only when over the limit", () => {
    const s = overviewParts(false, recent, false);
    expect(s.recent.map((x) => x.frontmatter.id)).toEqual(["b", "c"]);
    expect(s.showRecent).toBe(true);
    expect(s.showSpend).toBe(false);
    expect(overviewParts(false, recent, true).showSpend).toBe(true);
  });
  it("simple hides Recent when nothing in it went wrong", () => {
    expect(overviewParts(false, [t("a", "done")], false).showRecent).toBe(false);
    expect(overviewParts(false, [], false).showRecent).toBe(false);
  });
});
