/** A path Electron inserts (the unpackaged app directory, or a mount path). Not a subcommand. */
function isPathWord(token: string): boolean {
  return token.startsWith("/") || /^[A-Za-z]:[\\/]/.test(token);
}

/**
 * True when this process was started as `boof-runner sandbox check`.
 * Flags and path-like arguments are ignored: Electron and the AppImage runtime insert both.
 */
export function isSandboxCheckArgv(argv: readonly string[]): boolean {
  const words: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--" || token.startsWith("-") || isPathWord(token)) continue;
    words.push(token);
  }
  return words.length === 2 && words[0] === "sandbox" && words[1] === "check";
}
