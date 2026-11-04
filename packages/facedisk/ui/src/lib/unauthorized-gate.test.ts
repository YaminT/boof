import { describe, expect, it, vi } from "vitest";
import { createUnauthorizedGate } from "./unauthorized-gate.js";

function setup(initial = "old") {
  let token: string | undefined = initial;
  const notify = vi.fn();
  const gate = createUnauthorizedGate(() => token, notify);
  return { gate, notify, setToken: (t: string) => (token = t) };
}

describe("unauthorized gate", () => {
  it("a 401 for the current key always opens the gate", () => {
    const { gate, notify } = setup();
    expect(gate.unauthorized("old")).toBe("notified");
    expect(gate.unauthorized(undefined)).toBe("notified");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("a 401 for a key that was replaced is stale and ignored", () => {
    const { gate, notify, setToken } = setup();
    setToken("new");
    expect(gate.unauthorized("old")).toBe("stale");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a 401 for the key under rotation is held, then dropped when the rotation succeeds", () => {
    const { gate, notify, setToken } = setup();
    gate.begin("old");
    expect(gate.unauthorized("old")).toBe("held");
    setToken("new");
    gate.succeeded();
    expect(notify).not.toHaveBeenCalled();
    // Afterwards the old key's 401 is stale.
    expect(gate.unauthorized("old")).toBe("stale");
  });

  it("a held 401 is replayed when the rotation fails", () => {
    const { gate, notify } = setup();
    gate.begin("old");
    gate.unauthorized("old");
    expect(notify).not.toHaveBeenCalled();
    gate.failed();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("a failed rotation with nothing held notifies nothing", () => {
    const { gate, notify } = setup();
    gate.begin("old");
    gate.failed();
    expect(notify).not.toHaveBeenCalled();
  });

  it("rotate your own key, then another admin revokes the new key: the gate opens", () => {
    const { gate, notify, setToken } = setup();
    gate.begin("old");
    setToken("new");
    gate.succeeded();
    expect(gate.unauthorized("new")).toBe("notified");
    expect(notify).toHaveBeenCalledOnce();
  });
});
