import { describe, expect, it } from "vitest";
import { execCommand } from "./exec.js";

describe("execCommand", () => {
  it("survives a child that exits before reading its stdin (no uncaught EPIPE)", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      // 8 MB is far more than a pipe buffer, so the write is still pending when
      // `true` exits; before the fix this raised an uncaught EPIPE.
      const res = await execCommand("true", [], {
        cwd: process.cwd(),
        input: "x".repeat(8 * 1024 * 1024),
        timeoutMs: 10000,
      });
      expect(res.code).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
