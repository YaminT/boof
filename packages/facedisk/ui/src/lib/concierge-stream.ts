export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse one chunk of `text/event-stream`. `carry` is the unfinished tail of the previous chunk,
 * including an event that has not yet ended with a blank line. Comment lines are ignored.
 */
export function parseSse(carry: string, chunk: string): { events: SseEvent[]; carry: string } {
  const text = carry + chunk;
  const events: SseEvent[] = [];
  let eventName = "";
  let data: string[] = [];
  let i = 0;
  let blockStart = 0;
  while (i < text.length) {
    const nl = text.slice(i).search(/\r\n|\n|\r/);
    if (nl === -1) return { events, carry: text.slice(blockStart) };
    const at = i + nl;
    // A bare "\r" at the end of the buffer may be the first half of "\r\n".
    if (text[at] === "\r" && at + 1 === text.length) {
      return { events, carry: text.slice(blockStart) };
    }
    const sep = text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1;
    const line = text.slice(i, at);
    const next = at + sep;
    if (line === "") {
      if (data.length > 0 || eventName) {
        events.push({ event: eventName || "message", data: data.join("\n") });
      }
      eventName = "";
      data = [];
      blockStart = next;
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") data.push(value);
    }
    i = next;
  }
  return { events, carry: text.slice(blockStart) };
}
