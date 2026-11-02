import { describe, expect, it } from "vitest";
import type { PublicClient, Whoami } from "../api-types.js";
import {
  clientFormProblems,
  clientState,
  heldScopes,
  isOwnKey,
  NEW_CLIENT,
  SCOPE_ORDER,
  SCOPE_TEXT,
  sortClients,
  toCreateClientInput,
} from "./clients.js";

const client = (over: Partial<PublicClient> = {}): PublicClient => ({
  id: "c",
  name: "C",
  kind: "harness",
  scopes: ["tasks:read"],
  projects: "*",
  trust: "review",
  created: "2026-01-01T00:00:00.000Z",
  ...over,
});
const who = (kind: "local" | "client", id: string, scopes: string[]): Whoami =>
  ({
    principal: { kind, id, name: id, trust: "trusted", scopes, projects: "*" },
    server: { version: "1", authMode: "required", mcpEnabled: true },
  }) as unknown as Whoami;
const NOW = Date.parse("2026-06-01T00:00:00Z");

describe("scopes", () => {
  it("describes exactly the twelve scopes, in order", () => {
    expect(Object.keys(SCOPE_TEXT)).toHaveLength(12);
    expect(new Set(Object.keys(SCOPE_TEXT))).toEqual(new Set(SCOPE_ORDER));
    expect(SCOPE_ORDER).toHaveLength(12);
  });
});

describe("clientState and sortClients", () => {
  it("tells revoked, expired and active apart", () => {
    expect(clientState(client({ revokedAt: "2026-02-01T00:00:00Z" }), NOW)).toBe("revoked");
    expect(clientState(client({ expiresAt: "2026-05-01T00:00:00Z" }), NOW)).toBe("expired");
    expect(clientState(client({ expiresAt: "2026-07-01T00:00:00Z" }), NOW)).toBe("active");
    expect(clientState(client(), NOW)).toBe("active");
  });
  it("puts an older active key before a newer revoked one", () => {
    const old = client({ id: "old", created: "2026-01-01T00:00:00Z" });
    const revoked = client({
      id: "rev",
      created: "2026-05-01T00:00:00Z",
      revokedAt: "2026-05-02T00:00:00Z",
    });
    const newer = client({ id: "new", created: "2026-03-01T00:00:00Z" });
    expect(sortClients([revoked, old, newer], NOW).map((c) => c.id)).toEqual(["new", "old", "rev"]);
  });
});

describe("heldScopes", () => {
  it("is all for admin, the local principal and an unknown caller", () => {
    expect(heldScopes(who("client", "a", ["admin"]))).toBe("all");
    expect(heldScopes(who("local", "local", []))).toBe("all");
    expect(heldScopes(null)).toBe("all");
  });
  it("is the exact set for a restricted client", () => {
    const h = heldScopes(who("client", "a", ["auth:admin", "tasks:read"]));
    expect(h).not.toBe("all");
    expect([...(h as ReadonlySet<string>)].sort()).toEqual(["auth:admin", "tasks:read"]);
  });
});

describe("clientFormProblems", () => {
  const ok = { ...NEW_CLIENT, name: "n" };
  it("says what is missing", () => {
    expect(clientFormProblems(ok, "all")).toEqual([]);
    expect(clientFormProblems({ ...ok, name: " " }, "all")).toEqual(["Name the key."]);
    expect(clientFormProblems({ ...ok, scopes: [] }, "all")).toEqual([
      "Choose at least one scope.",
    ]);
    expect(clientFormProblems({ ...ok, projects: [] }, "all")).toEqual([
      "Choose at least one project, or allow every project.",
    ]);
  });
  it("names the scopes the caller cannot grant", () => {
    const held = new Set(["tasks:read"] as const);
    expect(clientFormProblems({ ...ok, scopes: ["tasks:read", "plans:write"] }, held)).toEqual([
      "Your own key cannot grant: plans:write.",
    ]);
  });
});

describe("toCreateClientInput", () => {
  it("trims, leaves out an empty expiry and sends admin alone", () => {
    const a = toCreateClientInput({ ...NEW_CLIENT, name: " x ", expiresIn: "" });
    expect(a.name).toBe("x");
    expect("expiresIn" in a).toBe(false);
    expect(
      toCreateClientInput({ ...NEW_CLIENT, name: "x", scopes: ["admin", "tasks:read"] }).scopes,
    ).toEqual(["admin"]);
    expect(toCreateClientInput({ ...NEW_CLIENT, name: "x" }).expiresIn).toBe("30d");
  });
});

describe("isOwnKey", () => {
  it("matches only the calling client", () => {
    expect(isOwnKey(client({ id: "me" }), who("client", "me", []))).toBe(true);
    expect(isOwnKey(client({ id: "me" }), who("client", "other", []))).toBe(false);
    expect(isOwnKey(client({ id: "local" }), who("local", "local", []))).toBe(false);
    expect(isOwnKey(client(), null)).toBe(false);
  });
});
