import type { AnyOperation } from "./define-op.js";
import { accountOps } from "./ops/accounts.js";
import { adminOps } from "./ops/admin.js";
import { planOps } from "./ops/plans.js";
import { projectOps } from "./ops/projects.js";
import { epicOps } from "./ops/epics.js";
import { taskOps } from "./ops/tasks.js";
import { webhookOps } from "./ops/webhooks.js";
import { n8nOps } from "./ops/n8n.js";
import { whoamiOps } from "./ops/whoami.js";
import { conciergeOps } from "./ops/concierge.js";

/** Every operation, in the order the docs and the OpenAPI document list them. */
export const registry: readonly AnyOperation[] = [
  ...whoamiOps,
  ...projectOps,
  ...planOps,
  ...taskOps,
  ...epicOps,
  ...adminOps,
  ...accountOps,
  ...webhookOps,
  ...n8nOps,
  ...conciergeOps,
];

const byName = new Map(registry.map((op) => [op.name, op]));
if (byName.size !== registry.length) throw new Error("duplicate operation name in the registry");

export function getOp(name: string): AnyOperation | undefined {
  return byName.get(name);
}
