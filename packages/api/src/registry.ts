import type { AnyOperation } from "./define-op.js";
import { adminOps } from "./ops/admin.js";
import { planOps } from "./ops/plans.js";
import { projectOps } from "./ops/projects.js";
import { taskOps } from "./ops/tasks.js";
import { webhookOps } from "./ops/webhooks.js";

/** Every operation, in the order the docs and the OpenAPI document list them. */
export const registry: readonly AnyOperation[] = [
  ...projectOps,
  ...planOps,
  ...taskOps,
  ...adminOps,
  ...webhookOps,
];

const byName = new Map(registry.map((op) => [op.name, op]));
if (byName.size !== registry.length) throw new Error("duplicate operation name in the registry");

export function getOp(name: string): AnyOperation | undefined {
  return byName.get(name);
}
