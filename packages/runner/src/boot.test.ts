import { describe, expect, it } from "vitest";
import { boot } from "./boot.js";

describe("boot", () => {
  it("starts server then runner and stops runner then server", async () => {
    const order: string[] = [];
    const result = await boot({
      startServer: async () => {
        order.push("start server");
        return "server";
      },
      afterServer: () => {
        order.push("server ready");
      },
      startRunner: () => {
        order.push("start runner");
        return "runner";
      },
      stopRunner: () => {
        order.push("stop runner");
      },
      afterRunnerStop: () => {
        order.push("after runner");
      },
      stopServer: () => {
        order.push("stop server");
      },
    });
    expect(result.server).toBe("server");
    expect(result.runner).toBe("runner");
    await result.stop();
    expect(order).toEqual([
      "start server",
      "server ready",
      "start runner",
      "stop runner",
      "after runner",
      "stop server",
    ]);
  });

  it("propagates startup failures unchanged", async () => {
    const failure = Object.assign(new Error("server failed"), { exitCode: 37 });
    await expect(
      boot({ startServer: async () => Promise.reject(failure), stopServer: async () => {} }),
    ).rejects.toBe(failure);
  });
});
