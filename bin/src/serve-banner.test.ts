import { describe, expect, it } from "vitest";
import { serveBanner } from "./boof-runner.js";

const base = { scheme: "http", hostPart: "127.0.0.1", port: 4319 } as const;

describe("serveBanner", () => {
  it("local-trust + loopback: Web UI line is the sign-in link with the hint", () => {
    const link = "http://127.0.0.1:4319/auth/browser?code=bl_abc";
    expect(serveBanner({ ...base, authMode: "local-trust", loopback: true, link })).toEqual([
      `Web UI:  ${link}`,
      '  (sign-in link: single use, 10 minutes; later run "boof-runner open")',
      "API:     http://127.0.0.1:4319/api",
    ]);
  });

  it("required mode or a non-loopback bind: plain URL as before", () => {
    const plain = ["Web UI:  http://127.0.0.1:4319", "API:     http://127.0.0.1:4319/api"];
    expect(serveBanner({ ...base, authMode: "required", loopback: true })).toEqual(plain);
    expect(
      serveBanner({ ...base, authMode: "required", loopback: true, link: "http://x/?code=bl_z" }),
    ).toEqual(plain);
    expect(serveBanner({ ...base, authMode: "local-trust", loopback: false })).toEqual(plain);
    expect(
      serveBanner({
        ...base,
        authMode: "local-trust",
        loopback: false,
        link: "http://x/?code=bl_z",
      }),
    ).toEqual(plain);
  });
});
