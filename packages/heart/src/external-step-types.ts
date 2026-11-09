// Pure types shared by the runner, the server and the UI. Browser-safe: no runtime imports.
import type { ExternalStepPoint } from "./schema.js";

export interface ExternalStepPayload {
  boof: { version: string; kind: "step" | "check" };
  run: { id: string; callbackUrl: string; token: string; expiresAt: string };
  step: { id: string; label: string; at: ExternalStepPoint | "check" };
  task: {
    project: string;
    id: string;
    title: string;
    prompt: string;
    labels: string[];
    priority: number;
    iteration: number;
    branch?: string;
    base?: string;
  };
  reports: { planner?: string; developer?: string; reviewer?: string };
  diff?: string;
}

export interface ExternalTriggerRequest {
  projectId: string;
  taskId: string;
  stepId: string;
  runId: string;
  workflowId: string;
  webhookPath: string;
  payload: ExternalStepPayload;
  signal: AbortSignal;
}

export type ExternalTriggerResult =
  | { ok: true; sent: "answered" | "timed-out-after-send" }
  | { ok: false; retryable: boolean; reason: string };

export interface ExternalStepTransport {
  /** Why no external step can run now, or null: "n8n is not configured", or the no-server message. */
  preflight(): Promise<string | null>;
  trigger(req: ExternalTriggerRequest): Promise<ExternalTriggerResult>;
}

export interface ExternalRunResult {
  status: "ok" | "failed";
  report: string;
  summary?: string;
  receivedAt: string;
}
