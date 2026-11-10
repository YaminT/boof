import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  LOCAL_MCP_ID,
  LOCAL_PRINCIPAL,
  SecuritySettingsSchema,
  type Settings,
} from "@boof/heart";
import { LocalPrincipalError, localPrincipal } from "./local-principal.js";

let root: string;
let authStore: AuthStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-localp-"));
  authStore = new AuthStore(root);
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const settings = (
  mode: "local-trust" | "required" = "local-trust",
  mcpEnabled = true,
): Settings => {
  const s = defaultSettings();
  s.security = SecuritySettingsSchema.parse({ auth: { mode } });
  s.mcp = { enabled: mcpEnabled } as Settings["mcp"];
  return s;
};

describe("localPrincipal", () => {
  it("local-trust without a client gives LOCAL_PRINCIPAL", async () => {
    const resolve = await localPrincipal({ settings: settings(), authStore });
    expect(await resolve()).toEqual(LOCAL_PRINCIPAL);
  });

  it("required without a client refuses", async () => {
    await expect(localPrincipal({ settings: settings("required"), authStore })).rejects.toThrow(
      LocalPrincipalError,
    );
    await expect(localPrincipal({ settings: settings("required"), authStore })).rejects.toThrow(
      /pass --client <id>/,
    );
  });

  it.each(["local-trust", "required"] as const)(
    "a client gives its own scopes, projects and trust (%s)",
    async (mode) => {
      const { client } = await authStore.create({
        name: "reader",
        scopes: ["tasks:read"],
        projects: ["shop"],
        trust: "review",
      });
      const resolve = await localPrincipal({
        settings: settings(mode),
        authStore,
        client: client.id,
      });
      const p = await resolve();
      expect(p).toMatchObject({ kind: "client", id: client.id, trust: "review" });
      expect([...p.scopes]).toEqual(["tasks:read"]);
      expect(p.projects).toEqual(new Set(["shop"]));
    },
  );

  it("unknown, revoked and expired clients are refused at start", async () => {
    const start = (client: string) => localPrincipal({ settings: settings(), authStore, client });
    await expect(start("nobody")).rejects.toThrow("unknown client: nobody");
    const revoked = await authStore.create({ name: "gone", scopes: ["tasks:read"] });
    await authStore.revoke(revoked.client.id);
    await expect(start(revoked.client.id)).rejects.toThrow(
      `client ${revoked.client.id} is revoked`,
    );
    const expired = await authStore.create({
      name: "old",
      scopes: ["tasks:read"],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(start(expired.client.id)).rejects.toThrow(
      `client ${expired.client.id} has expired`,
    );
    await expect(start("nobody")).rejects.toBeInstanceOf(LocalPrincipalError);
  });

  it("a client revoked after start is refused on the next call", async () => {
    const { client } = await authStore.create({ name: "late", scopes: ["tasks:read"] });
    const resolve = await localPrincipal({ settings: settings(), authStore, client: client.id });
    await expect(resolve()).resolves.toMatchObject({ id: client.id });
    await authStore.revoke(client.id);
    await expect(resolve()).rejects.toThrow(`client ${client.id} is revoked`);
    await expect(resolve()).rejects.toBeInstanceOf(LocalPrincipalError);
  });

  it("ignores settings.mcp.enabled", async () => {
    const resolve = await localPrincipal({ settings: settings("local-trust", false), authStore });
    expect(await resolve()).toEqual(LOCAL_PRINCIPAL);
  });

  it("the reserved id stays reserved: no client can be created with it", async () => {
    const made = await authStore.create({ name: "local-mcp", scopes: ["tasks:read"] });
    expect(made.client.id).not.toBe(LOCAL_MCP_ID);
  });

  it("refuses --client local-mcp when clients.json holds a client from before the reservation", async () => {
    await authStore.create({ name: "old", scopes: ["tasks:read"] });
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = join(root, "auth", "clients.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.clients[0].id = LOCAL_MCP_ID;
    await writeFile(file, JSON.stringify(raw));
    await expect(
      localPrincipal({ settings: settings(), authStore, client: LOCAL_MCP_ID }),
    ).rejects.toThrow(/reserved.*auth revoke local-mcp/s);
    // The administrator is not affected.
    await expect(localPrincipal({ settings: settings(), authStore })).resolves.toBeTypeOf(
      "function",
    );
  });
});
