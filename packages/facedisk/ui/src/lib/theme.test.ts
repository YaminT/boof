import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTheme, retainThemeStore, themePrefFromStorage } from "./theme.js";

describe("resolveTheme", () => {
  it("follows the system when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
  it("reads a stored preference and treats anything else as system", () => {
    expect(themePrefFromStorage("dark")).toBe("dark");
    expect(themePrefFromStorage("light")).toBe("light");
    expect(themePrefFromStorage(null)).toBe("system");
    expect(themePrefFromStorage("nope")).toBe("system");
  });
  it("an explicit preference wins over the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("retainThemeStore", () => {
  let release: (() => void) | null = null;
  afterEach(() => {
    release?.();
    release = null;
    vi.unstubAllGlobals();
  });

  /** A page with no theme control mounted: only the app-level subscription. */
  function install(dark: boolean) {
    const media = new Set<() => void>();
    const onStorage = new Set<(e: { key: string | null; newValue: string | null }) => void>();
    const classes = new Set<string>();
    const dataset: Record<string, string> = {};
    const stored = new Map<string, string>();
    let systemDark = dark;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
    });
    vi.stubGlobal("document", {
      documentElement: {
        dataset,
        classList: {
          toggle(name: string, on?: boolean) {
            const next = on ?? !classes.has(name);
            if (next) classes.add(name);
            else classes.delete(name);
            return next;
          },
        },
      },
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({
        get matches() {
          return systemDark;
        },
        addEventListener(_t: string, fn: () => void) {
          media.add(fn);
        },
        removeEventListener(_t: string, fn: () => void) {
          media.delete(fn);
        },
      }),
      addEventListener(
        type: string,
        fn: (e: { key: string | null; newValue: string | null }) => void,
      ) {
        if (type === "storage") onStorage.add(fn);
      },
      removeEventListener(
        type: string,
        fn: (e: { key: string | null; newValue: string | null }) => void,
      ) {
        if (type === "storage") onStorage.delete(fn);
      },
    });
    return {
      classes,
      dataset,
      stored,
      setDark(v: boolean) {
        systemDark = v;
      },
      fireMedia() {
        for (const fn of media) fn();
      },
      fireStorage(value: string | null) {
        stored.set("boof-runner.theme", value ?? "");
        if (value === null) stored.delete("boof-runner.theme");
        for (const fn of onStorage) fn({ key: "boof-runner.theme", newValue: value });
      },
    };
  }

  it("applies an OS change that happened while no theme control was mounted", () => {
    const env = install(false);
    release = retainThemeStore();
    expect(env.dataset.theme).toBe("light");
    expect(env.classes.has("dark")).toBe(false);
    release();
    release = null;
    // The OS switches in the gap, with no listener left to hear the change event.
    env.setDark(true);
    release = retainThemeStore();
    expect(env.dataset.theme).toBe("dark");
    expect(env.classes.has("dark")).toBe(true);
  });

  it("follows the OS and another tab while only the app subscription is mounted", () => {
    const env = install(false);
    release = retainThemeStore();
    expect(env.dataset.theme).toBe("light");
    env.setDark(true);
    env.fireMedia();
    expect(env.dataset.theme).toBe("dark");
    env.fireStorage("light");
    expect(env.dataset.theme).toBe("light");
    expect(env.classes.has("dark")).toBe(false);
  });
});
