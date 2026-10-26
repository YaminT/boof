import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "./openapi.js";
import { registry } from "./registry.js";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi", "openapi.json");

describe("OpenAPI document", () => {
  const doc = buildOpenApi(registry);
  const text = JSON.stringify(doc, null, 2) + "\n";

  it("matches the committed snapshot (UPDATE_OPENAPI=1 rewrites it)", () => {
    if (process.env["UPDATE_OPENAPI"] === "1" || !existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, text);
    }
    expect(text).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("describes every operation once", () => {
    const ids = Object.values(
      doc["paths"] as Record<string, Record<string, { operationId: string }>>,
    )
      .flatMap((p) => Object.values(p))
      .map((o) => o.operationId)
      .filter((id) => id !== "events.stream") // the SSE stream is not a registry operation
      .sort();
    expect(ids).toEqual(registry.map((o) => o.name).sort());
  });
});
