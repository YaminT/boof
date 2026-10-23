// Pure types, browser-safe (no runtime imports).
import type { TaskFrontmatter } from "./schema.js";

/** The fixed body sections of a task file, in canonical order. */
export interface TaskReports {
  planner: string;
  developer: string;
  observer: string;
  reviewer: string;
}

export interface TaskBody {
  prompt: string;
  command: string;
  questions: string;
  answers: string;
  reports: TaskReports;
  /** Raw, append-only agent output captured across the pipeline run. Mirrored
   * into the task file so it survives the working-area deletion on done/failed
   * and stays viewable in the UI (output-visibility). */
  log: string;
}

export interface Task {
  frontmatter: TaskFrontmatter;
  body: TaskBody;
}
