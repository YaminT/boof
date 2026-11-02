import { describe, expect, it } from "vitest";
import { createAuthHold } from "./auth-hold.js";

describe("auth hold", () => {
  it("holds for the given time and no longer", () => {
    let t = 1000;
    const h = createAuthHold(() => t);
    expect(h.held()).toBe(false);
    h.hold(500);
    expect(h.held()).toBe(true);
    t = 1499;
    expect(h.held()).toBe(true);
    t = 1500;
    expect(h.held()).toBe(false);
  });
  it("release ends it at once", () => {
    const h = createAuthHold(() => 0);
    h.hold();
    h.release();
    expect(h.held()).toBe(false);
  });
});
