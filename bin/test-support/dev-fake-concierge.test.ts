import { describe, expect, it } from "vitest";
import { devFakeConcierge } from "./dev-fake-concierge.js";

describe("devFakeConcierge", () => {
  it("answers as available, or as unavailable on request", async () => {
    const on = devFakeConcierge("available");
    expect((await on.availability({} as never)).available).toBe(true);
    const off = devFakeConcierge("unavailable");
    expect(await off.availability({} as never)).toMatchObject({ available: false, via: null });
  });
});
