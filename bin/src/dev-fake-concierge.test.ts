import { describe, expect, it } from "vitest";
import { devFakeConcierge } from "./dev-fake-concierge.js";

describe("devFakeConcierge", () => {
  it("is off without the flag", () => {
    expect(devFakeConcierge({})).toBeUndefined();
  });

  it("is ignored when NODE_ENV is production", () => {
    expect(
      devFakeConcierge({ BOOF_DEV_FAKE_CONCIERGE: "1", NODE_ENV: "production" }),
    ).toBeUndefined();
  });

  it("answers as available, or as unavailable on request", async () => {
    const on = devFakeConcierge({ BOOF_DEV_FAKE_CONCIERGE: "1" })!;
    expect((await on.availability({} as never)).available).toBe(true);
    const off = devFakeConcierge({ BOOF_DEV_FAKE_CONCIERGE: "unavailable" })!;
    expect(await off.availability({} as never)).toMatchObject({ available: false, via: null });
  });
});
