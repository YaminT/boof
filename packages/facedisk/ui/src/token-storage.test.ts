import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken, getToken, isKeyRemembered, setToken } from "./token.js";

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const blocked = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

let session: MemoryStorage;
let local: MemoryStorage;

beforeEach(() => {
  session = new MemoryStorage();
  local = new MemoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
});
afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe("remembering the API key", () => {
  it("keeps the key in this tab only by default", () => {
    setToken(" boof_a ");
    expect(session.getItem("boofToken")).toBe("boof_a");
    expect(local.m.size).toBe(0);
    expect(isKeyRemembered()).toBe(false);
  });

  it("remember on: the key survives a new tab", () => {
    setToken("boof_a", true);
    expect(local.getItem("boofToken")).toBe("boof_a");
    expect(session.m.size).toBe(0);
    expect(isKeyRemembered()).toBe(true);
    expect(getToken()).toBe("boof_a");
  });

  it("a new key without remember replaces a remembered one", () => {
    setToken("boof_a", true);
    setToken("boof_b");
    expect(local.m.size).toBe(0);
    expect(getToken()).toBe("boof_b");
  });

  it("clear forgets the key in both stores", () => {
    session.setItem("boofToken", "x");
    local.setItem("boofToken", "y");
    local.setItem("boofInstance", "i");
    clearToken();
    expect(session.m.size).toBe(0);
    expect(local.m.size).toBe(0);
    expect(getToken()).toBeUndefined();
  });

  it("works with storage blocked", () => {
    vi.stubGlobal("sessionStorage", blocked);
    vi.stubGlobal("localStorage", blocked);
    expect(() => setToken("boof_a", true)).not.toThrow();
    expect(getToken()).toBeUndefined();
    expect(isKeyRemembered()).toBe(false);
    expect(() => clearToken()).not.toThrow();
  });

  it("falls back to the tab when only localStorage is blocked", () => {
    vi.stubGlobal("localStorage", blocked);
    setToken("boof_a", true);
    expect(getToken()).toBe("boof_a");
    clearToken();
    expect(session.m.size).toBe(0);
  });
});
