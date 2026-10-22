import type { Role } from "@boof-runner/shared";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { parseUsage } from "./usage.js";

/**
 * In-process control surface for the mock tool, used by tests to drive the
 * pipeline deterministically and offline (tool-adapters / runner-pipeline
 * specs). No network is ever touched.
 */
export interface MockState {
  /** Questions the planner raises on its FIRST planning attempt. */
  plannerQuestions: string[];
  /** If set, the named role's run throws (to exercise failure handling). */
  failRole: Role | null;
  /** Internal: whether the planner has already asked this run. */
  hasAsked: boolean;
  /** Every prompt the mock has received (tests inspect the injected framing). */
  prompts: string[];
  /** Test hook run before the mock responds (e.g. write/commit files in opts.cwd). */
  onRun: ((opts: RunOptions) => Promise<void>) | null;
  /** Internal: rounds seen per `cwd|role`, used to pick the scripted verdict. */
  roundCounts: Map<string, number>;
  /** Every role the mock has been invoked for, in order. */
  calls: Role[];
}

export const mockState: MockState = {
  plannerQuestions: [],
  failRole: null,
  hasAsked: false,
  prompts: [],
  onRun: null,
  roundCounts: new Map(),
  calls: [],
};

export function resetMock(): void {
  mockState.plannerQuestions = [];
  mockState.failRole = null;
  mockState.hasAsked = false;
  mockState.prompts = [];
  mockState.onRun = null;
  mockState.roundCounts = new Map();
  mockState.calls = [];
}

/**
 * Scripted verdicts, embedded in the task prompt as
 * `[[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]`.
 * Tokens: APPROVE | CHANGES_REQUESTED | REJECT | NONE (no verdict line) |
 * GARBLED (`VERDICT: MAYBE`) | CONFLICT (two disagreeing final lines). Round N
 * of a role uses the Nth token; past the end the last token repeats. The
 * marker must sit on one line (the CLI truncates the title copy of the prompt,
 * which must never match), the last complete marker wins, and unknown tokens
 * throw.
 */
const MARKER = /\[\[mock-verdicts[ \t]+([^\]\n]*)\]\]/g;

const TOKENS = new Set(["APPROVE", "CHANGES_REQUESTED", "REJECT", "NONE", "GARBLED", "CONFLICT"]);

function scriptedTokens(prompt: string, role: Role): string[] {
  const m = [...prompt.matchAll(MARKER)].at(-1);
  if (!m) return [];
  let found: string[] = [];
  for (const part of m[1]!.trim().split(/\s+/)) {
    const [name, list] = part.split("=");
    const tokens = (list ?? "").split(",").filter(Boolean);
    for (const token of tokens) {
      if (!TOKENS.has(token)) throw new Error(`unknown mock verdict token: ${token}`);
    }
    if (name === role && tokens.length > 0) found = tokens;
  }
  return found;
}

function verdictBlock(role: Role, round: number, token: string): string {
  switch (token) {
    case "NONE":
      return "";
    case "GARBLED":
      return "VERDICT: MAYBE";
    case "CONFLICT":
      return "VERDICT: APPROVE\nVERDICT: REJECT";
    case "CHANGES_REQUESTED":
      return `- finding: mock issue ${role} round ${round}\nVERDICT: CHANGES_REQUESTED`;
    case "APPROVE":
      return "VERDICT: APPROVE";
    case "REJECT":
      return "VERDICT: REJECT";
    default:
      throw new Error(`unknown mock verdict token: ${token}`);
  }
}

const usageLine = "input_tokens: 100 output_tokens: 42 cost: $0.01";

export class MockTool implements Tool {
  readonly id = "mock";
  readonly displayName = "Mock Tool";
  readonly defaultModels = ["mock-default"];

  async detect(): Promise<HealthResult> {
    return { status: "available", message: "Mock tool is always available", version: "1.0.0" };
  }

  async listModels(): Promise<string[]> {
    return [...this.defaultModels];
  }

  async run(opts: RunOptions): Promise<RunResult> {
    mockState.prompts.push(opts.prompt);
    mockState.calls.push(opts.role);
    await mockState.onRun?.(opts);
    if (mockState.failRole === opts.role) {
      throw new Error(`Mock failure injected for role ${opts.role}`);
    }

    // Each iteration starts with the planner: restart scripted verdict rounds.
    if (opts.role === "planner") {
      mockState.roundCounts.delete(`${opts.cwd}|observer`);
      mockState.roundCounts.delete(`${opts.cwd}|reviewer`);
    }

    // Planner asks its configured questions exactly once (ask-once-then-resume).
    if (opts.role === "planner" && mockState.plannerQuestions.length > 0 && !mockState.hasAsked) {
      mockState.hasAsked = true;
      const output = `MOCK planner questions\n${usageLine}`;
      return {
        output,
        report: "Planner needs clarification before producing a plan.",
        questions: [...mockState.plannerQuestions],
        usage: parseUsage(output),
      };
    }

    let report = reportFor(opts.role);
    if (opts.role === "observer" || opts.role === "reviewer") {
      const key = `${opts.cwd}|${opts.role}`;
      const round = (mockState.roundCounts.get(key) ?? 0) + 1;
      mockState.roundCounts.set(key, round);
      const tokens = scriptedTokens(opts.prompt, opts.role);
      const token = tokens.length > 0 ? tokens[Math.min(round, tokens.length) - 1]! : "APPROVE";
      const block = verdictBlock(opts.role, round, token);
      if (block) report += `\n\n${block}`;
    }

    const output = `MOCK ${opts.role} (${opts.model}) ran in ${opts.cwd}\n${usageLine}`;
    return {
      output,
      report,
      usage: parseUsage(output),
    };
  }
}

function reportFor(role: Role): string {
  switch (role) {
    case "planner":
      return "# Plan\n\n1. Step one.\n2. Step two.";
    case "developer":
      return "# Developer report\n\nImplemented the plan (mock; no real changes).";
    case "observer":
      return "# Observer report\n\nChecked the diff against the plan (mock observer).";
    case "reviewer":
      return "# Review\n\nLooks good (mock review).";
  }
}
