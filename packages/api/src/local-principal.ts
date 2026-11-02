import {
  LOCAL_PRINCIPAL,
  securitySettings,
  type AuthStore,
  type Client,
  type Principal,
  type Settings,
} from "@boof-runner/shared";

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
 * The principal a local surface (stdio MCP, the generated CLI) acts as. With `client`, that
 * client: checked now and again on every call, so a revocation applies at once, with no key (the
 * OS user owns the data root). Without it, LOCAL_PRINCIPAL, but only when `security.auth.mode` is
 * "local-trust". It does not look at `settings.mcp`: that switch belongs to the MCP surface.
 */
export async function localPrincipal(opts: {
  settings: Settings;
  authStore: AuthStore;
  client?: string;
}): Promise<() => Promise<Principal>> {
  const resolveClient = async (id: string): Promise<Principal> => {
    const client = await opts.authStore.get(id);
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
