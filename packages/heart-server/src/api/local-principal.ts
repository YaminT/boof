import {
  LOCAL_MCP_ID,
  LOCAL_PRINCIPAL,
  SCOPES,
  securitySettings,
  type AuthStore,
  type Client,
  type Principal,
  type Scope,
  type Settings,
} from "@boof/heart";

/** The scopes the removed keyless local-mcp principal had: every scope except admin, auth:admin, settings:write. */
export const MCP_REVIEW_SCOPES: readonly Scope[] = SCOPES.filter(
  (s) => s !== "admin" && s !== "auth:admin" && s !== "settings:write",
);

/** A local surface cannot act: an unknown, revoked or expired client, or `required` mode without one. */
export class LocalPrincipalError extends Error {}

export function principalFromClient(client: Client): Principal {
  return {
    kind: "client",
    id: client.id,
    name: client.name,
    scopes: new Set(client.scopes),
    projects: client.projects === "*" ? "*" : new Set(client.projects),
    trust: client.trust,
    clientKind: client.kind,
  };
}

/**
 * The principal a local surface (the generated CLI) acts as. With `client`, that client: checked
 * now and again on every call, so a revocation applies at once, with no key (the OS user owns the
 * data root). Without it, LOCAL_PRINCIPAL, but only when `security.auth.mode` is "local-trust":
 * there it is the local administrator (the CLI, which the human runs directly). Stdio MCP always
 * passes a client. It does not look at `settings.mcp`: that switch
 * belongs to the MCP surface.
 */
export async function localPrincipal(opts: {
  settings: Settings;
  authStore: AuthStore;
  client?: string;
}): Promise<() => Promise<Principal>> {
  const resolveClient = async (id: string): Promise<Principal> => {
    const client = await opts.authStore.get(id);
    if (client && id === LOCAL_MCP_ID) {
      throw new LocalPrincipalError(
        `client ${id} uses a reserved id (made before it was reserved) and is refused: boof-runner auth revoke ${id}`,
      );
    }
    if (!client) throw new LocalPrincipalError(`unknown client: ${id}`);
    if (client.revokedAt) throw new LocalPrincipalError(`client ${id} is revoked`);
    if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) {
      throw new LocalPrincipalError(`client ${id} has expired`);
    }
    return principalFromClient(client);
  };
  if (opts.client !== undefined) {
    const id = opts.client;
    await resolveClient(id); // fail at start, not on the first call
    return () => resolveClient(id);
  }
  if (securitySettings(opts.settings).auth.mode !== "local-trust") {
    throw new LocalPrincipalError(
      'security.auth.mode is "required": pass --client <id> (create one with "boof-runner auth add")',
    );
  }
  return async () => LOCAL_PRINCIPAL;
}
