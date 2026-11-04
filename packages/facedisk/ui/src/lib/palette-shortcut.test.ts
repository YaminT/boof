import { describe, expect, it } from "vitest";
import { isPaletteShortcut, type KeyLike } from "./palette-shortcut.js";

const key = (over: Partial<KeyLike> = {}): KeyLike => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("isPaletteShortcut", () => {
  it("accepts ⌘K on macOS", () => {
    expect(isPaletteShortcut(key({ metaKey: true }), true, false)).toBe(true);
  });
  it("rejects Ctrl+K on macOS", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }), true, false)).toBe(false);
  });
  it("accepts Ctrl+K elsewhere", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }), false, false)).toBe(true);
  });
  it("rejects ⌘K elsewhere", () => {
    expect(isPaletteShortcut(key({ metaKey: true }), false, false)).toBe(false);
  });
  it("accepts an uppercase K", () => {
    expect(isPaletteShortcut(key({ key: "K", ctrlKey: true }), false, false)).toBe(true);
  });
  it("rejects other keys and a bare K", () => {
    expect(isPaletteShortcut(key({ key: "j", ctrlKey: true }), false, false)).toBe(false);
    expect(isPaletteShortcut(key(), false, false)).toBe(false);
  });
  it("rejects extra modifiers", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }), false, false)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false, false)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, metaKey: true }), false, false)).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true, ctrlKey: true }), true, false)).toBe(false);
  });
  it("ignores a field outside the palette and allows the palette's own", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }), false, true)).toBe(false);
    // The caller passes false for the palette's own input, so the toggle still works there.
    expect(isPaletteShortcut(key({ ctrlKey: true }), false, false)).toBe(true);
  });
});
