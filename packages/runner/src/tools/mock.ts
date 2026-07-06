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
}

export const mockState: MockState = {
  plannerQuestions: [],
  failRole: null,
  hasAsked: false,
  prompts: [],
};

export function resetMock(): void {
  mockState.plannerQuestions = [];
  mockState.failRole = null;
  mockState.hasAsked = false;
  mockState.prompts = [];
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
    if (mockState.failRole === opts.role) {
      throw new Error(`Mock failure injected for role ${opts.role}`);
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

    const output = `MOCK ${opts.role} (${opts.model}) ran in ${opts.cwd}\n${usageLine}`;
    return {
      output,
      report: reportFor(opts.role),
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
    case "reviewer":
      return "# Review\n\nLooks good (mock review).";
  }
}
