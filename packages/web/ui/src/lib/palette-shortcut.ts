export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * True when the keydown should toggle the palette: ⌘K on macOS, Ctrl+K elsewhere, with no other
 * modifier, and not while typing in a field outside the palette.
 */
export function isPaletteShortcut(
  e: KeyLike,
  isMac: boolean,
  editableOutsidePalette: boolean,
): boolean {
  if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey) return false;
  const modifierOk = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return modifierOk && !editableOutsidePalette;
}
