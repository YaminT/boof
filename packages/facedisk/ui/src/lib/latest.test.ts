import { describe, expect, it } from "vitest";
import { latestGuard } from "./latest.js";

describe("latestGuard", () => {
  it("drops a reply that arrives after a later one", () => {
    const g = latestGuard();
    const a = g.begin();
    const b = g.begin();
    expect(g.accept(b)).toBe(true);
    expect(g.accept(a)).toBe(false);
  });
  it("accepts replies in order", () => {
    const g = latestGuard();
    const a = g.begin();
    const b = g.begin();
    expect(g.accept(a)).toBe(true);
    expect(g.accept(b)).toBe(true);
  });
  it("keeps guards independent", () => {
    const g1 = latestGuard();
    const g2 = latestGuard();
    const a = g1.begin();
    const b = g1.begin();
    g1.accept(b);
    const c = g2.begin();
    expect(g2.accept(c)).toBe(true);
    expect(g1.accept(a)).toBe(false);
  });
});
