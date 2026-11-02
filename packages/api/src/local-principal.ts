import {
  LOCAL_MCP_ID,
  LOCAL_PRINCIPAL,
  SCOPES,
  securitySettings,
  type AuthStore,
  type Client,
  type Principal,
  type Settings,
} from "@boof-runner/shared";

export { LOCAL_MCP_ID };

/**
 * The principal of a keyless stdio MCP server without `--admin`: a fixed review-trust client with
 * every scope except the administrator's (`admin`, `auth:admin`, `settings:write`). The rules for
 * review-trust clients then apply to whatever the host's model asks for: its tasks and plans are
 * drafts a human approves, it cannot queue, retry, answer, activate a plan or switch the runner,
 * it changes only its own work and only the name, labels and paused state of a project, and it
 * creates no project.
 */
export const LOCAL_MCP_PRINCIPAL: Principal = {
  kind: "client",
  id: LOCAL_MCP_ID,
  name: LOCAL_MCP_ID,
  scopes: new Set(
    SCOPES.filter((s) => s !== "admin" && s !== "auth:admin" && s !== "settings:write"),
  ),
  projects: "*",
  trust: "review",
  clientKind: "mcp",
};

/** Why a keyless MCP server refuses to start when clients.json holds the reserved id. */
export const RESERVED_ID_MESSAGE =
  `clients.json holds a client with the reserved id ${LOCAL_MCP_ID} (made before the id was reserved): ` +
  "remove its entry from auth/clients.json, or start with --admin or --client <id>";

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
 * "local-trust": there it is the local administrator (the CLI, which the human runs directly), or,
 * with `withoutClient: "review"` (the keyless MCP server without `--admin`), LOCAL_MCP_PRINCIPAL.
 * It does not look at `settings.mcp`: that switch belongs to the MCP surface.
 */
export async function localPrincipal(opts: {
  settings: Settings;
  authStore: AuthStore;
  client?: string;
  /** Who acts without a client: the local administrator (default) or the review-trust MCP principal. */
  withoutClient?: "admin" | "review";
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
  if (opts.withoutClient === "review" && (await opts.authStore.get(LOCAL_MCP_ID))) {
    // A client of this id from before the id was reserved would be confused with the keyless MCP
    // principal. It cannot be removed through the API (revoked clients stay in the file).
    throw new LocalPrincipalError(RESERVED_ID_MESSAGE);
  }
  return async () => (opts.withoutClient === "review" ? LOCAL_MCP_PRINCIPAL : LOCAL_PRINCIPAL);
}
