import { describe, expect, it } from "vitest";
import { UsageTap } from "./usage-tap.js";

const sse = (...events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

describe("UsageTap", () => {
  it("counts SSE usage across split chunks and survives junk", () => {
    const tap = new UsageTap("text/event-stream");
    const text =
      "event: ping\ndata: {not json\n\n" +
      sse(
        {
          type: "message_start",
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } },
        },
        { type: "content_block_delta", delta: {} },
        { type: "message_delta", usage: { output_tokens: 42 } },
      ) +
      "data: [DONE]\n\ndata: \n";
    for (let i = 0; i < text.length; i += 7) tap.write(text.slice(i, i + 7));
    expect(tap.end()).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  it("reads usage from a JSON body", () => {
    const tap = new UsageTap("application/json");
    tap.write(Buffer.from(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 7 } })));
    expect(tap.end()).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it("returns undefined for junk and never throws", () => {
    const tap = new UsageTap("application/json");
    tap.write("<html>");
    expect(tap.end()).toBeUndefined();
    const s = new UsageTap(undefined);
    s.write(Buffer.alloc(10));
    expect(s.end()).toBeUndefined();
  });

  it("drops an oversized SSE line without losing later events", () => {
    const tap = new UsageTap("text/event-stream");
    tap.write("data: " + "x".repeat(300 * 1024));
    tap.write("\n" + sse({ type: "message_delta", usage: { output_tokens: 3 } }));
    expect(tap.end()).toEqual({ inputTokens: 0, outputTokens: 3 });
  });
});
