import matter from "gray-matter";
import { TaskFrontmatterSchema, type TaskFrontmatter } from "./schema.js";

/** The fixed body sections of a task file, in canonical order. */
export interface TaskReports {
  planner: string;
  developer: string;
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

const emptyBody = (): TaskBody => ({
  prompt: "",
  command: "",
  questions: "",
  answers: "",
  reports: { planner: "", developer: "", reviewer: "" },
  log: "",
});

const TOP_SECTIONS = ["prompt", "command", "questions", "answers", "reports", "log"];
const REPORT_SECTIONS = ["planner", "developer", "reviewer"];

/**
 * Split a markdown string into sections at the given header level, treating a
 * header as a section boundary ONLY when its title is one of `allowed`. The
 * task body has a fixed, known set of sections, so report/plan content may
 * freely contain its own `##`/`#` headers without breaking the parse.
 */
function splitSections(md: string, level: 2 | 3, allowed: string[]): Map<string, string> {
  const prefix = level === 2 ? "## " : "### ";
  const allow = new Set(allowed);
  const out = new Map<string, string>();
  const lines = md.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) out.set(current, buf.join("\n").trim());
  };
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      const title = line.slice(prefix.length).trim().toLowerCase();
      if (allow.has(title)) {
        flush();
        current = title;
        buf = [];
        continue;
      }
    }
    if (current !== null) buf.push(line);
  }
  flush();
  return out;
}

/** Parse a task file's raw markdown into a structured Task. Validates frontmatter. */
export function parseTask(raw: string): Task {
  const parsed = matter(raw);
  const frontmatter = TaskFrontmatterSchema.parse(parsed.data);
  const body = emptyBody();

  const sections = splitSections(parsed.content, 2, TOP_SECTIONS);
  body.prompt = sections.get("prompt") ?? "";
  body.command = sections.get("command") ?? "";
  body.questions = sections.get("questions") ?? "";
  body.answers = sections.get("answers") ?? "";
  body.log = sections.get("log") ?? "";

  const reportsRaw = sections.get("reports") ?? "";
  if (reportsRaw) {
    const sub = splitSections(reportsRaw, 3, REPORT_SECTIONS);
    body.reports.planner = sub.get("planner") ?? "";
    body.reports.developer = sub.get("developer") ?? "";
    body.reports.reviewer = sub.get("reviewer") ?? "";
  }

  return { frontmatter, body };
}

function sectionBlock(title: string, content: string): string {
  const trimmed = content.trim();
  return trimmed ? `## ${title}\n\n${trimmed}\n` : `## ${title}\n`;
}

function reportBlock(title: string, content: string): string {
  const trimmed = content.trim();
  return trimmed ? `### ${title}\n\n${trimmed}\n` : `### ${title}\n`;
}

/** Serialize a Task back to canonical markdown (frontmatter + fixed sections). */
export function serializeTask(task: Task): string {
  // Validate on the way out too, so we never persist an invalid frontmatter.
  const fm = TaskFrontmatterSchema.parse(task.frontmatter);
  const reports = [
    "## Reports",
    "",
    reportBlock("Planner", task.body.reports.planner),
    reportBlock("Developer", task.body.reports.developer),
    reportBlock("Reviewer", task.body.reports.reviewer),
  ].join("\n");

  const content = [
    sectionBlock("Prompt", task.body.prompt),
    sectionBlock("Command", task.body.command),
    sectionBlock("Questions", task.body.questions),
    sectionBlock("Answers", task.body.answers),
    reports,
    sectionBlock("Log", task.body.log),
  ].join("\n");

  // gray-matter stringify emits the YAML frontmatter fence + content.
  return matter.stringify("\n" + content.trimStart(), fm as Record<string, unknown>);
}

/** Build a fresh Task with empty body sections and sensible defaults. */
export function newTask(frontmatter: TaskFrontmatter, prompt = ""): Task {
  const body = emptyBody();
  body.prompt = prompt;
  return { frontmatter, body };
}
