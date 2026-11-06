import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWrite, readText, withFileLock } from "./atomic.js";
import { appendEvent } from "./events.js";
import { assertKebabId } from "./paths.js";
import { PlanSchema, type Plan } from "./plan-schema.js";
import { validatePlan } from "./plan-validate.js";
import { nowIso } from "./runtime.js";

/** `save` was given a version that is no longer the stored one: someone else wrote first. */
export class PlanVersionConflict extends Error {
  constructor(
    public readonly planId: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Plan ${planId} was changed by someone else (expected version ${expectedVersion}, current ${currentVersion})`,
    );
    this.name = "PlanVersionConflict";
  }
}

export class PlanNotFoundError extends Error {
  constructor(public readonly planId: string) {
    super(`Plan not found: ${planId}`);
    this.name = "PlanNotFoundError";
  }
}

export class PlanExistsError extends Error {
  constructor(public readonly planId: string) {
    super(`Plan already exists: ${planId}`);
    this.name = "PlanExistsError";
  }
}

/** Fields of a new plan; server-owned fields (version, timestamps) are filled in. */
export type CreatePlanInput = Omit<
  Partial<Plan>,
  "id" | "title" | "source" | "version" | "created" | "updated"
> &
  Pick<Plan, "id" | "title" | "source">;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const MODIFY_RETRIES = 4;

/**
 * File-backed plan repository: `<projectDir>/plans/<planId>.json`. Every write goes through
 * {@link save}, the only place `version` and `updated` change, under the file lock and against
 * the version that is stored right now (optimistic concurrency).
 */
export class PlanStore {
  constructor(private readonly projectDir: string) {}

  private emit(plan: Plan, by = "runner"): Promise<void> {
    return appendEvent(this.projectDir, {
      type: "plan.updated",
      project: basename(this.projectDir),
      plan: plan.id,
      version: plan.version,
      by,
    });
  }

  private path(id: string): string {
    return join(this.projectDir, "plans", `${assertKebabId(id)}.json`);
  }

  /** Plans sorted by id. Unreadable files are skipped. */
  async list(): Promise<Plan[]> {
    let names: string[];
    try {
      names = (await readdir(join(this.projectDir, "plans"))).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Plan[] = [];
    for (const name of names.sort()) {
      try {
        out.push(
          PlanSchema.parse(JSON.parse(await readText(join(this.projectDir, "plans", name)))),
        );
      } catch {
        // skip a corrupt file rather than hide every plan
      }
    }
    return out;
  }

  /** The plan, or null when it does not exist. Throws InvalidIdError for a non-kebab id. */
  async get(id: string): Promise<Plan | null> {
    const path = this.path(id);
    let text: string;
    try {
      text = await readText(path);
    } catch {
      return null;
    }
    return PlanSchema.parse(JSON.parse(text));
  }

  async require(id: string): Promise<Plan> {
    const plan = await this.get(id);
    if (!plan) throw new PlanNotFoundError(id);
    return plan;
  }

  /** Create a plan at version 1 (goals validated, order normalised). Throws PlanExistsError. */
  async create(input: CreatePlanInput, opts: { by?: string } = {}): Promise<Plan> {
    const path = this.path(input.id);
    const now = nowIso();
    const plan = validatePlan(
      PlanSchema.parse({ goals: [], ...input, version: 1, created: now, updated: now }),
      { normalizeOrder: true },
    );
    await withFileLock(path, async () => {
      if (await exists(path)) throw new PlanExistsError(input.id);
      await atomicWrite(path, JSON.stringify(plan, null, 2) + "\n");
    });
    await this.emit(plan, opts.by);
    return plan;
  }

  /**
   * Write `plan` over the stored one when the stored version is `expectedVersion`; otherwise
   * throw {@link PlanVersionConflict}. Validates and normalises the goals, bumps `version`,
   * refreshes `updated`, keeps `created`. Returns the plan as stored.
   * Appends a `plan.updated` event (`opts.by`: the actor, default `runner`).
   */
  async save(plan: Plan, opts: { expectedVersion: number; by?: string }): Promise<Plan> {
    const path = this.path(plan.id);
    const saved = await withFileLock(path, async () => {
      const stored = await this.get(plan.id);
      if (!stored) throw new PlanNotFoundError(plan.id);
      if (stored.version !== opts.expectedVersion) {
        throw new PlanVersionConflict(plan.id, opts.expectedVersion, stored.version);
      }
      const next = validatePlan(
        PlanSchema.parse({
          ...plan,
          created: stored.created,
          version: stored.version + 1,
          updated: nowIso(),
        }),
        { normalizeOrder: true },
      );
      await atomicWrite(path, JSON.stringify(next, null, 2) + "\n");
      return next;
    });
    await this.emit(saved, opts.by);
    return saved;
  }

  /**
   * Read-modify-write. With `expectedVersion` a stale version fails with
   * {@link PlanVersionConflict}; without it the change is applied to the latest version and
   * retried a few times when another writer gets in between. `fn` may return the same plan
   * object when there is nothing to change: nothing is written then.
   */
  async modify(
    id: string,
    fn: (plan: Plan) => Plan | Promise<Plan>,
    opts: { expectedVersion?: number; by?: string } = {},
  ): Promise<Plan> {
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.require(id);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
        throw new PlanVersionConflict(id, opts.expectedVersion, current.version);
      }
      const next = await fn(structuredClone(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      try {
        return await this.save(next, { expectedVersion: current.version, by: opts.by });
      } catch (err) {
        const retry =
          err instanceof PlanVersionConflict &&
          opts.expectedVersion === undefined &&
          attempt < MODIFY_RETRIES;
        if (!retry) throw err;
      }
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
