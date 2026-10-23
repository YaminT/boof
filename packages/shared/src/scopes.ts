import type { ClientKind, Scope, Trust } from "./schema.js";

/**
 * The authenticated caller of an API request. `local` is a loopback peer under
 * `local-trust`; `client` is a bearer-key holder.
 */
export interface Principal {
  kind: "local" | "client";
  id: string;
  name: string;
  scopes: ReadonlySet<Scope>;
  projects: "*" | ReadonlySet<string>;
  trust: Trust;
  /** Client kind, for task provenance. Absent for the local principal. */
  clientKind?: ClientKind;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.has("admin") || principal.scopes.has(scope);
}

/** Scope check. Project restriction is a separate call: {@link authorizeProject}. */
export function authorize(principal: Principal, scope: Scope): boolean {
  return hasScope(principal, scope);
}

/**
 * Project restriction hook. The API is single-project today, so routes do not
 * call it yet; the multi-project routes (plan 02) call it with the target project id.
 */
export function authorizeProject(principal: Principal, projectId: string): boolean {
  return principal.projects === "*" || principal.projects.has(projectId);
}

export const LOCAL_PRINCIPAL: Principal = {
  kind: "local",
  id: "local",
  name: "local",
  scopes: new Set<Scope>(["admin"]),
  projects: "*",
  trust: "trusted",
};
