// Mirrors the shared task/settings shapes the API returns. Kept local so the UI
// bundle does not import the Node-oriented shared package.

export type Status = "draft" | "pending" | "running" | "action" | "done" | "failed" | "archived";
export type QuestionState = "none" | "pending" | "answered";

export interface RoleAssignment {
  tool: string;
  model: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  known: boolean;
}

export interface Attachment {
  name: string;
  type: string;
  size: number;
}

export interface TaskFrontmatter {
  id: string;
  title: string;
  status: Status;
  priority: number;
  skip: boolean;
  labels: string[];
  command: string | null;
  attachments: Attachment[];
  questions: QuestionState;
  runs: number;
  completedRuns: number;
  tokens?: TokenUsage;
  created: string;
  updated: string;
}

export interface TaskBody {
  prompt: string;
  command: string;
  questions: string;
  answers: string;
  reports: { planner: string; developer: string; reviewer: string };
  /** Raw agent output captured across the pipeline run. */
  log: string;
}

export interface Task {
  frontmatter: TaskFrontmatter;
  body: TaskBody;
}

export interface CommandTemplate {
  id: string;
  name: string;
  body: string;
}

export interface Settings {
  runner: { enabled: boolean };
  workingDirectory: string;
  selectedSubdirectory: string | null;
  blockHours: unknown[];
  tokens: Record<string, unknown>;
  roles: { planner: RoleAssignment; developer: RoleAssignment; reviewer: RoleAssignment };
  models: Record<string, string[]>;
}

export interface HealthResult {
  status: "available" | "unavailable";
  message: string;
  version?: string;
}
