import type { Role } from "@boof-runner/shared";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { execCommand } from "../exec.js";
import { ToolRunError } from "./errors.js";
import { parseUsage } from "./usage.js";
import { formatQuestions, withQuestions } from "./questions.js";

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
  /** Every system prompt the mock has received, with its role. */
  systemPrompts: { role: Role; systemPrompt: string }[];
  /** Questions the planner raises once in its refinement pass (the prompt has an existing plan). */
  refinementQuestions: string[];
  /** Questions a non-planner role raises on its FIRST run (routed to the planner). */
  roleQuestions: Partial<Record<Role, string[]>>;
  /** Internal: simulated transient failures already thrown, per role. */
  transientCounts: Map<Role, number>;
  /** Internal: simulated stalls already run, per role. */
  stallCounts: Map<Role, number>;
  /** Whether the mock reports `supportsResume`; tests turn it off to exercise the restart fallback. */
  resumeSupported: boolean;
  /** Internal: last session id handed out (`mock-session-N`). */
  sessionCounter: number;
  /** Every resumed run: the session it continued, its role and the prompt it got. */
  resumes: { role: Role; sessionId: string; prompt: string }[];
}

export const mockState: MockState = {
  plannerQuestions: [],
  failRole: null,
  hasAsked: false,
  prompts: [],
  onRun: null,
  roundCounts: new Map(),
  calls: [],
  systemPrompts: [],
  roleQuestions: {},
  refinementQuestions: [],
  transientCounts: new Map(),
  stallCounts: new Map(),
  resumeSupported: true,
  sessionCounter: 0,
  resumes: [],
};

export function resetMock(): void {
  mockState.plannerQuestions = [];
  mockState.failRole = null;
  mockState.hasAsked = false;
  mockState.prompts = [];
  mockState.onRun = null;
  mockState.roundCounts = new Map();
  mockState.calls = [];
  mockState.systemPrompts = [];
  mockState.roleQuestions = {};
  mockState.refinementQuestions = [];
  mockState.transientCounts = new Map();
  mockState.stallCounts = new Map();
  mockState.resumeSupported = true;
  mockState.sessionCounter = 0;
  mockState.resumes = [];
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

/**
 * Simulated failures, embedded in the task prompt like the verdict marker:
 * `[[mock-transient developer=1 reviewer=2]]` makes the first N runs of a role
 * fail with `API Error: 503`; `[[mock-stall developer=1]]` makes the first N
 * runs go silent (a real silent child, killed by the idle watchdog). Single
 * line, last marker wins, counted per role in mockState.
 */
const TRANSIENT_MARKER = /\[\[mock-transient[ \t]+([^\]\n]*)\]\]/g;
const STALL_MARKER = /\[\[mock-stall[ \t]+([^\]\n]*)\]\]/g;

function markerCount(prompt: string, marker: RegExp, role: Role): number {
  const m = [...prompt.matchAll(marker)].at(-1);
  if (!m) return 0;
  for (const part of m[1]!.trim().split(/\s+/)) {
    const [name, n] = part.split("=");
    if (name === role) return Number(n) || 0;
  }
  return 0;
}

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

/**
 * Cost of each mock step, embedded in the task prompt: `[[mock-cost 0.5]]` makes every step cost
 * $0.50, `[[mock-cost unknown]]` makes steps report no usage at all. Default $0.01. Last marker wins.
 */
const COST_MARKER = /\[\[mock-cost[ \t]+([^\]\n]*)\]\]/g;

function usageLineFor(prompt: string): string {
  const m = [...prompt.matchAll(COST_MARKER)].at(-1);
  const value = m?.[1]?.trim();
  if (value === "unknown") return "";
  const cost = value !== undefined && Number.isFinite(Number(value)) ? Number(value) : 0.01;
  return `input_tokens: 100 output_tokens: 42 cost: $${cost}`;
}

export class MockTool implements Tool {
  readonly id = "mock";
  readonly displayName = "Mock Tool";
  readonly defaultModels = ["mock-default"];

  get supportsResume(): boolean {
    return mockState.resumeSupported;
  }

  async detect(): Promise<HealthResult> {
    return { status: "available", message: "Mock tool is always available", version: "1.0.0" };
  }

  async listModels(): Promise<string[]> {
    return [...this.defaultModels];
  }

  async run(opts: RunOptions): Promise<RunResult> {
    mockState.prompts.push(opts.prompt);
    mockState.calls.push(opts.role);
    mockState.systemPrompts.push({ role: opts.role, systemPrompt: opts.systemPrompt });
    // A session id per run; a resumed run keeps the id it continues and says so in its output.
    const sessionId = opts.resumeSessionId ?? `mock-session-${++mockState.sessionCounter}`;
    if (opts.resumeSessionId) {
      mockState.resumes.push({ role: opts.role, sessionId, prompt: opts.prompt });
    }
    const resumed = opts.resumeSessionId ? ` resumed ${sessionId}` : "";
    await mockState.onRun?.(opts);
    if (mockState.failRole === opts.role) {
      throw new Error(`Mock failure injected for role ${opts.role}`);
    }

    const failFirst = markerCount(opts.prompt, TRANSIENT_MARKER, opts.role);
    const failed = mockState.transientCounts.get(opts.role) ?? 0;
    if (failed < failFirst) {
      mockState.transientCounts.set(opts.role, failed + 1);
      throw new ToolRunError(
        "mock",
        1,
        false,
        false,
        "API Error: 503 Service Unavailable",
        "",
        false,
        0,
        {
          usage: parseUsage(usageLineFor(opts.prompt)),
        },
      );
    }
    const stallFirst = markerCount(opts.prompt, STALL_MARKER, opts.role);
    const stalls = mockState.stallCounts.get(opts.role) ?? 0;
    if (stalls < stallFirst) {
      mockState.stallCounts.set(opts.role, stalls + 1);
      const res = await execCommand(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        cwd: opts.cwd,
        idleTimeoutMs: opts.idleTimeoutMs,
        stopSignalPath: opts.stopSignalPath,
        steerSignalPath: opts.steerSignalPath,
      });
      throw new ToolRunError(
        "mock",
        res.code,
        res.timedOut,
        res.stopped,
        "mock went silent",
        res.stderr,
        res.stalled,
        opts.idleTimeoutMs,
        {
          steered: res.steered,
          sessionId,
          // The interrupted attempt still cost something.
          usage: res.steered ? parseUsage(usageLineFor(opts.prompt)) : undefined,
        },
      );
    }

    // Each iteration starts with the planner: restart scripted verdict rounds.
    if (opts.role === "planner") {
      mockState.roundCounts.delete(`${opts.cwd}|observer`);
      mockState.roundCounts.delete(`${opts.cwd}|reviewer`);
    }

    // The refinement pass asks its configured questions once.
    if (
      opts.role === "planner" &&
      mockState.refinementQuestions.length > 0 &&
      opts.prompt.includes("## Existing plan")
    ) {
      const qs = [...mockState.refinementQuestions];
      mockState.refinementQuestions = [];
      const output = `MOCK planner refinement questions\n${usageLineFor(opts.prompt)}`;
      return withQuestions({
        output,
        sessionId,
        report: `Refinement needs clarification.\n\n${formatQuestions(qs)}`,
        usage: parseUsage(output),
      });
    }

    // Planner asks its configured questions exactly once (ask-once-then-resume).
    if (opts.role === "planner" && mockState.plannerQuestions.length > 0 && !mockState.hasAsked) {
      mockState.hasAsked = true;
      const output = `MOCK planner questions\n${usageLineFor(opts.prompt)}`;
      const qs = [...mockState.plannerQuestions];
      return withQuestions({
        output,
        sessionId,
        report: `Planner needs clarification before producing a plan.\n\n${formatQuestions(qs)}`,
        usage: parseUsage(output),
      });
    }

    // A non-planner role raises its configured questions once.
    const asked = mockState.roleQuestions[opts.role];
    if (opts.role !== "planner" && asked && asked.length > 0) {
      delete mockState.roleQuestions[opts.role];
      const output = `MOCK ${opts.role} questions\n${usageLineFor(opts.prompt)}`;
      return withQuestions({
        output,
        sessionId,
        report: `${reportFor(opts.role)}\n\n${formatQuestions([...asked])}`,
        usage: parseUsage(output),
      });
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

    const output = `MOCK ${opts.role} (${opts.model})${resumed} ran in ${opts.cwd}\n${usageLineFor(opts.prompt)}`;
    return {
      output,
      sessionId,
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
