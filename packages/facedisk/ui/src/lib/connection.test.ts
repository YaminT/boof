import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_TTL_MS,
  checkHealth,
  getConnection,
  reportSignedIn,
  reportSignedOut,
  reportStreamDown,
  reportStreamUp,
  resetConnection,
  subscribeConnection,
  tooltip,
} from "./connection.js";
import { announcement } from "../shell/ConnectionIndicator.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

let health: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(new Date(2026, 0, 1, 12, 41));
  health = vi.fn(async () => new Response("{}", { status: 200 }));
  resetConnection({ fetchImpl: health as unknown as typeof fetch });
});
afterEach(() => vi.useRealTimers());

describe("connection state", () => {
  it("goes live -> reconnecting -> live", async () => {
    reportStreamUp();
    expect(getConnection().state).toBe("live");
    reportStreamDown();
    await flush();
    expect(getConnection().state).toBe("reconnecting"); // the server still answers /healthz
    reportStreamUp();
    expect(getConnection()).toEqual({ state: "live", since: null });
  });

  it("goes offline when /healthz also fails, dated from then, and back when the stream returns", async () => {
    health.mockRejectedValue(new Error("down"));
    reportStreamDown();
    await flush();
    const c = getConnection();
    expect(c.state).toBe("offline");
    expect(c.since).toBe(Date.now());
    expect(tooltip(c, () => "12:41")).toBe("Offline since 12:41");
    reportStreamUp();
    expect(getConnection().state).toBe("live");
  });

  it("a 401 means signed-out, and signing in goes back to reconnecting", () => {
    reportStreamUp();
    reportSignedOut();
    expect(getConnection().state).toBe("signed-out");
    // a failing stream does not hide the sign-in need
    reportStreamDown();
    expect(getConnection().state).toBe("signed-out");
    reportSignedIn();
    expect(getConnection().state).toBe("reconnecting");
  });

  it("asks /healthz at most once a minute while the stream is down", async () => {
    reportStreamDown();
    await flush();
    for (let i = 0; i < 5; i++) {
      reportStreamDown(); // each failed reconnect attempt
      await flush();
    }
    expect(health).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + HEALTH_TTL_MS + 1);
    await checkHealth();
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("never asks /healthz while live", async () => {
    reportStreamUp();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(health).not.toHaveBeenCalled();
  });

  it("notifies subscribers only on a change, and announces words", () => {
    const fn = vi.fn();
    const off = subscribeConnection(fn);
    reportStreamUp(); // live -> live
    expect(fn).not.toHaveBeenCalled();
    reportSignedOut();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(announcement(getConnection())).toBe("Sign in needed");
    expect(tooltip({ state: "live", since: null })).toBe("Connected");
    expect(tooltip({ state: "reconnecting", since: 1 })).toBe("Reconnecting…");
    off();
  });
});
