/** True when a file name is valid on Windows as well: no `:<>"|?*`, no trailing dot or space, no device names. */
export function isPortableName(name: string): boolean {
  if (name.includes(":") || /[. ]$/.test(name) || /[<>"|?*]/.test(name)) return false;
  const base = name
    .split(".")[0]!
    .replace(/[. ]+$/g, "")
    .toUpperCase();
  return !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(base);
}
