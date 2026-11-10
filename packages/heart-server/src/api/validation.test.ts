import { describe, expect, it } from "vitest";
import { InjectBody } from "./validation.js";

describe("inject model validation", () => {
  it("accepts a model only with mode now", () => {
    expect(
      InjectBody.safeParse({ prompt: "do it", mode: "now", model: "claude-3.7" }).success,
    ).toBe(true);
    expect(
      InjectBody.safeParse({ prompt: "do it", mode: "next-step", model: "opus" }).success,
    ).toBe(false);
    expect(InjectBody.safeParse({ prompt: "do it", mode: "now", model: "bad model" }).success).toBe(
      false,
    );
  });
});
