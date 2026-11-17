const PATTERNS: RegExp[] = [/sk-ant-[A-Za-z0-9_-]+/g, /bgw_[A-Za-z0-9_-]{20,}/g];

/** Replace Anthropic keys, gateway run tokens and any extra secret strings in a text. */
export function redactSecrets(text: string, extra: Iterable<string> = []): string {
  let out = text;
  for (const secret of extra) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
