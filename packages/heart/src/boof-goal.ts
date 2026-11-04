/**
 * Faithful, self-contained reader/writer for boof-planner's `goal.boof.xml` and
 * `plan.boof.xml` files. Ported from boof-planner (src/schema.ts, src/xml.ts,
 * src/plan.ts) so boof-runner can ingest scanned units and bump their status
 * without depending on the planner package. The schema semantics are kept
 * identical: highest <version> number = current status, statuses are
 * plan|develop|review|done, and plan `order` is topologically consistent with
 * `depends-on`.
 */
import { XMLBuilder, XMLParser } from "fast-xml-parser";

export const GOAL_FILE = "goal.boof.xml";
export const PLAN_FILE = "plan.boof.xml";

export const BOOF_STATUSES = ["plan", "develop", "review", "done"] as const;
export type BoofStatus = (typeof BOOF_STATUSES)[number];

export function isBoofStatus(value: unknown): value is BoofStatus {
  return typeof value === "string" && (BOOF_STATUSES as readonly string[]).includes(value);
}

/** One entry in <progress><status><versions>. The highest number is current. */
export interface BoofVersion {
  number: number;
  status: BoofStatus;
  description: string;
}

export interface BoofTests {
  strategy: string;
  technology: string;
  run: string;
  coverage?: string;
}

/** Parsed goal.boof.xml. */
export interface BoofGoal {
  /** Optional: which AI model the developing agent should use for this unit. */
  model?: string;
  overal: {
    goal: string;
    stack: string;
    rules: { do: string[]; dont: string[] };
  };
  progress: {
    versions: BoofVersion[];
    tests: BoofTests;
  };
}

/** One tracked goal inside plan.boof.xml. */
export interface PlanGoal {
  id: string;
  /** Directory (relative to the plan root) that holds the goal.boof.xml. */
  path: string;
  /** Development order (1-based, topologically consistent with dependsOn). */
  order: number;
  /** Last recorded status (cache; the goal file on disk is the source of truth). */
  status: BoofStatus;
  dependsOn: string[];
}

export interface BoofPlan {
  goals: PlanGoal[];
}

export class BoofValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`invalid boof file:\n- ${errors.join("\n- ")}`);
    this.name = "BoofValidationError";
  }
}

/** Current status of a goal = status of its highest version number. */
export function currentStatus(goal: BoofGoal): BoofStatus {
  const versions = goal.progress.versions;
  if (versions.length === 0) return "plan";
  return versions.reduce((a, b) => (b.number > a.number ? b : a)).status;
}

/**
 * Return a new goal with a version appended that carries `status`, using the
 * next version number. Does not mutate the input (used for status write-back).
 */
export function appendVersion(goal: BoofGoal, status: BoofStatus, description: string): BoofGoal {
  const maxNumber = goal.progress.versions.reduce((m, v) => Math.max(m, v.number), 0);
  return {
    ...goal,
    progress: {
      ...goal.progress,
      versions: [
        ...goal.progress.versions.map((v) => ({ ...v })),
        { number: maxNumber + 1, status, description },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

const ARRAY_PATHS = new Set([
  "boof.overal.rules.do",
  "boof.overal.rules.dont",
  "boof.progress.status.versions.version",
  "plan.goals.goal",
  "plan.goals.goal.depends-on",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (_name, jpath) => ARRAY_PATHS.has(String(jpath)),
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
});

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    return t == null ? "" : String(t);
  }
  return String(node);
}

function textList(value: unknown): string[] {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(textOf).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// goal.boof.xml
// ---------------------------------------------------------------------------

export function goalErrors(xml: string): string[] {
  let raw: any;
  try {
    raw = parser.parse(xml);
  } catch (e) {
    return [`XML parse error: ${(e as Error).message}`];
  }
  const errors: string[] = [];
  const boof = raw?.boof;
  if (!boof || typeof boof !== "object") return ["missing <boof> root element"];

  const overal = boof.overal;
  if (!overal || typeof overal !== "object") {
    errors.push("missing <overal> section");
  } else {
    if (!textOf(overal.goal)) errors.push("<overal><goal> is required and must not be empty");
    if (!textOf(overal.stack)) errors.push("<overal><stack> is required and must not be empty");
    const dos = textList(overal.rules?.do);
    if (dos.length === 0) errors.push("<overal><rules> must contain at least one <do>");
  }

  const progress = boof.progress;
  if (!progress || typeof progress !== "object") {
    errors.push("missing <progress> section");
  } else {
    const versions = progress.status?.versions?.version;
    const list: any[] = Array.isArray(versions) ? versions : versions ? [versions] : [];
    if (list.length === 0) {
      errors.push("<progress><status><versions> must contain at least one <version>");
    } else {
      const seen = new Set<number>();
      for (const v of list) {
        const num = Number(v?.["@_number"]);
        if (!Number.isInteger(num) || num < 1) {
          errors.push("<version> number attribute must be a positive integer");
        } else if (seen.has(num)) {
          errors.push(`duplicate <version> number "${num}"`);
        } else {
          seen.add(num);
        }
        if (!isBoofStatus(v?.["@_status"])) {
          errors.push(
            `<version> status attribute must be one of plan|develop|review|done (got "${v?.["@_status"] ?? ""}")`,
          );
        }
      }
    }
    const tests = progress.tests;
    if (!tests || typeof tests !== "object") {
      errors.push("missing <progress><tests> section");
    } else {
      if (!textOf(tests.strategy)) errors.push("<tests><strategy> is required");
      if (!textOf(tests.technology)) errors.push("<tests><technology> is required");
      if (!textOf(tests.run)) errors.push("<tests><run> is required");
    }
  }
  return errors;
}

export function parseGoal(xml: string): BoofGoal {
  const errors = goalErrors(xml);
  if (errors.length > 0) throw new BoofValidationError(errors);
  const boof = parser.parse(xml).boof;
  const model = textOf(boof.model);
  const rawVersions: any[] = boof.progress.status.versions.version;
  const versions: BoofVersion[] = rawVersions
    .map((v: any) => ({
      number: Number(v["@_number"]),
      status: v["@_status"] as BoofStatus,
      description: textOf(v),
    }))
    .sort((a, b) => a.number - b.number);
  const tests = boof.progress.tests;
  const coverage = textOf(tests.coverage);
  return {
    ...(model ? { model } : {}),
    overal: {
      goal: textOf(boof.overal.goal),
      stack: textOf(boof.overal.stack),
      rules: {
        do: textList(boof.overal.rules?.do),
        dont: textList(boof.overal.rules?.dont),
      },
    },
    progress: {
      versions,
      tests: {
        strategy: textOf(tests.strategy),
        technology: textOf(tests.technology),
        run: textOf(tests.run),
        ...(coverage ? { coverage } : {}),
      },
    },
  };
}

export function serializeGoal(goal: BoofGoal): string {
  const obj = {
    boof: {
      ...(goal.model ? { model: goal.model } : {}),
      overal: {
        goal: goal.overal.goal,
        stack: goal.overal.stack,
        rules: {
          do: goal.overal.rules.do,
          ...(goal.overal.rules.dont.length > 0 ? { dont: goal.overal.rules.dont } : {}),
        },
      },
      progress: {
        status: {
          versions: {
            version: goal.progress.versions.map((v) => ({
              "#text": v.description,
              "@_number": String(v.number),
              "@_status": v.status,
            })),
          },
        },
        tests: {
          strategy: goal.progress.tests.strategy,
          technology: goal.progress.tests.technology,
          run: goal.progress.tests.run,
          ...(goal.progress.tests.coverage ? { coverage: goal.progress.tests.coverage } : {}),
        },
      },
    },
  };
  return XML_HEADER + builder.build(obj);
}

// ---------------------------------------------------------------------------
// plan.boof.xml
// ---------------------------------------------------------------------------

export function planErrors(xml: string): string[] {
  let raw: any;
  try {
    raw = parser.parse(xml);
  } catch (e) {
    return [`XML parse error: ${(e as Error).message}`];
  }
  const errors: string[] = [];
  const plan = raw?.plan;
  if (!plan || typeof plan !== "object") return ["missing <plan> root element"];
  const goals: any[] = plan.goals?.goal ?? [];
  if (goals.length === 0) errors.push("<plan><goals> must contain at least one <goal>");
  const ids = new Set<string>();
  for (const g of goals) {
    const id = String(g?.["@_id"] ?? "");
    if (!id) errors.push("<goal> id attribute is required");
    else if (ids.has(id)) errors.push(`duplicate <goal> id "${id}"`);
    else ids.add(id);
    if (!String(g?.["@_path"] ?? "")) errors.push(`<goal id="${id}"> path attribute is required`);
    const order = Number(g?.["@_order"]);
    if (!Number.isInteger(order) || order < 1) {
      errors.push(`<goal id="${id}"> order attribute must be a positive integer`);
    }
    const status = g?.["@_status"];
    if (status != null && !isBoofStatus(status)) {
      errors.push(`<goal id="${id}"> status must be one of plan|develop|review|done`);
    }
  }
  for (const g of goals) {
    for (const dep of textList(g?.["depends-on"])) {
      if (!ids.has(dep)) {
        errors.push(`<goal id="${g?.["@_id"]}"> depends on unknown goal "${dep}"`);
      }
    }
  }
  return errors;
}

export function parsePlan(xml: string): BoofPlan {
  const errors = planErrors(xml);
  if (errors.length > 0) throw new BoofValidationError(errors);
  const goals: any[] = parser.parse(xml).plan.goals.goal;
  const parsed: PlanGoal[] = goals.map((g: any) => ({
    id: String(g["@_id"]),
    path: String(g["@_path"]),
    order: Number(g["@_order"]),
    status: isBoofStatus(g["@_status"]) ? g["@_status"] : "plan",
    dependsOn: textList(g["depends-on"]),
  }));
  parsed.sort((a, b) => a.order - b.order);
  return { goals: parsed };
}

export function serializePlan(plan: BoofPlan): string {
  const obj = {
    plan: {
      goals: {
        goal: [...plan.goals]
          .sort((a, b) => a.order - b.order)
          .map((g) => ({
            ...(g.dependsOn.length > 0 ? { "depends-on": g.dependsOn } : {}),
            "@_id": g.id,
            "@_path": g.path,
            "@_order": String(g.order),
            "@_status": g.status,
          })),
      },
    },
  };
  return XML_HEADER + builder.build(obj);
}

// ---------------------------------------------------------------------------
// ordering / next-goal semantics (ported from boof-planner/src/plan.ts)
// ---------------------------------------------------------------------------

/**
 * Deterministic Kahn topological sort. Ties broken alphabetically by id.
 * Throws on unknown dependencies and on cycles.
 */
export function topoSort(items: { id: string; dependsOn: string[] }[]): string[] {
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`unknown dependency "${dep}" (required by "${item.id}")`);
      }
    }
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const item of items) {
    indegree.set(item.id, item.dependsOn.length);
    for (const dep of item.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(item.id);
    }
  }
  const ready = items
    .filter((i) => i.dependsOn.length === 0)
    .map((i) => i.id)
    .sort();
  const result: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const next of (dependents.get(id) ?? []).sort()) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (result.length !== items.length) {
    const stuck = items.map((i) => i.id).filter((id) => !result.includes(id));
    throw new Error(`dependency cycle among: ${stuck.sort().join(", ")}`);
  }
  return result;
}

/**
 * Next goal to develop: lowest order whose status is not "done" and whose
 * dependencies are all "done". Statuses from the map (scanned from disk)
 * override the cached plan status. Returns null when everything is done
 * or every remaining goal is blocked.
 */
export function nextGoal(
  goals: PlanGoal[],
  statuses: Map<string, BoofStatus> = new Map(),
): PlanGoal | null {
  const statusOf = (id: string): BoofStatus =>
    statuses.get(id) ?? goals.find((g) => g.id === id)?.status ?? "plan";
  const ordered = [...goals].sort((a, b) => a.order - b.order);
  for (const goal of ordered) {
    if (statusOf(goal.id) === "done") continue;
    if (goal.dependsOn.every((dep) => statusOf(dep) === "done")) return goal;
  }
  return null;
}
