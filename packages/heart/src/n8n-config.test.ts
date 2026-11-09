import { describe, expect, it } from "vitest";
import { joinUrl, n8nCallbackUrl, n8nEditorUrl, n8nWebhookUrl } from "./n8n-config.js";
import { N8nSettingsSchema } from "./schema.js";

describe("n8n-config", () => {
  it.each([
    ["https://h", "a", "https://h/a"],
    ["https://h/", "a", "https://h/a"],
    ["https://h/boof/", "callbacks/x", "https://h/boof/callbacks/x"],
    ["http://n8n:5678/webhook/", "p/q", "http://n8n:5678/webhook/p/q"],
    ["https://h//", "/a", "https://h/a"],
  ])("joinUrl makes exactly one slash and keeps a prefix: %s + %s", (base, path, want) => {
    expect(joinUrl(base, path)).toBe(want);
  });

  const s = N8nSettingsSchema.parse({
    baseUrl: "http://n8n:5678/",
    callbackBaseUrl: "https://yamin.lol/boof",
  });

  it("n8nWebhookUrl defaults to <baseUrl>/webhook", () => {
    expect(n8nWebhookUrl(s, "boof/ci")).toBe("http://n8n:5678/webhook/boof/ci");
    expect(n8nWebhookUrl({ ...s, webhookBaseUrl: "http://w:1/hooks/" }, "p")).toBe(
      "http://w:1/hooks/p",
    );
  });

  it("n8nCallbackUrl keeps the proxy prefix", () => {
    const id = "xr-" + "a".repeat(32);
    expect(n8nCallbackUrl(s, id)).toBe(`https://yamin.lol/boof/callbacks/external-steps/${id}`);
  });

  it("n8nEditorUrl links the workflow", () => {
    expect(n8nEditorUrl(s, "w1")).toBe("http://n8n:5678/workflow/w1");
  });
});
