import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseVerdict,
  resolveRole,
  reviewSettings,
  taskAssetPath,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  TaskStore,
  workingAreaDir,
  type Settings,
  type Task,
  type TokenUsage,
  type Verdict,
} from "@boof-runner/shared";
import { sumUsage } from "./tools/usage.js";
import type { RunOptions, RunResult, Tool } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import { UsageStore } from "./usage-store.js";
import {
  branchHead,
  diffAgainstBase,
  ensureWorktree,
  finalizeWorktree,
  isGitRepo,
  type Worktree,
} from "./worktree.js";

export interface PipelineDeps {
  root: string;
  store: TaskStore;
  registry: ToolRegistry;
  settings: Settings;
}

const VERDICT_PROTOCOL =
  "End the report with exactly one final line, one of: `VERDICT: APPROVE`; " +
  "`VERDICT: CHANGES_REQUESTED` (list the findings above it); `VERDICT: REJECT` (the work " +
  "should not be fixed in place). No text after that line. A missing or malformed verdict " +
  "counts as not approved.";

const SYSTEM_PROMPTS = {
  planner:
    "You are the PLANNER. Produce a concise implementation plan. If — and only if — " +
    "you genuinely cannot proceed without user input, list clarifying questions.",
  refine:
    "You are the PLANNER doing a refinement pass. Read the repo context and the existing " +
    "plan, then output an improved, final plan. Do not ask the user questions.",
  developer:
    "You are the DEVELOPER. Implement the plan in the working directory. Do not ask the " +
    "user questions; if truly blocked, state your question for the planner.",
  developerFix:
    "You are the DEVELOPER fixing review findings in the working directory. Fix each real " +
    "finding with a test, or rebut it with evidence. Do not ask the user questions; if truly " +
    "blocked, state your question for the planner.",
  observer:
    "You are the OBSERVER, a second pair of eyes after the developer. Check the diff against " +
    "the task prompt and the plan for correctness, missing tests and regressions. Do not ask " +
    "the user questions. Write a report listing concrete findings. " +
    VERDICT_PROTOCOL,
  reviewer:
    "You are the REVIEWER giving the final review. Review the diff for correctness and " +
    "quality. Do not ask the user questions. Write a review report. " +
    VERDICT_PROTOCOL,
} as const;

/** Current iteration number for a task (1-based). */
export function currentIteration(task: Task): number {
  return task.frontmatter.completedRuns + 1;
}

/** True when the iteration about to run is the task's last requested run. */
export function isFinalIteration(task: Task): boolean {
  return currentIteration(task) >= task.frontmatter.runs;
}

/**
 * Critical-review framing injected on every run after the first. The prior
 * run's work is present in the same worktree, so later runs are told to treat
 * it as another AI's solution and rigorously review/adjust it (runs feature).
 */
function iterationFraming(task: Task): string | null {
  const iteration = currentIteration(task);
  if (iteration <= 1) return null;
  return (
    `## Iteration ${iteration} of ${task.frontmatter.runs}\n` +
    `This is iteration ${iteration} of ${task.frontmatter.runs} for this task. A previous AI has ` +
    `already attempted it, and that work is present in the working directory. Act as a critical ` +
    `reviewer of another AI's solution: do not assume the existing work is correct or complete. ` +
    `Focus on review and adjustment — find bugs, gaps, and anything left behind, then fix and ` +
    `finish it. Be rigorous and skeptical, and make sure nothing is missing before you stop.`
  );
}

/** Thrown when the review gate ends without a reviewer APPROVE. */
class ReviewNotApprovedError extends Error {
  constructor(role: "observer" | "reviewer", verdict: Verdict | null) {
    super(`review not approved: ${role} ${verdict ?? "INVALID"}`);
    this.name = "ReviewNotApprovedError";
  }
}

/** Outcome of running the pipeline for a single task. */
export type PipelineOutcome =
  | { kind: "done"; task: Task }
  | { kind: "parked"; task: Task; questions: string[] }
  | { kind: "failed"; task: Task; error: string };

export class Pipeline {
  private readonly usageStore: UsageStore;
  constructor(private readonly deps: PipelineDeps) {
    this.usageStore = new UsageStore(deps.root);
  }

  private areaDir(id: string): string {
    return workingAreaDir(this.deps.root, id);
  }

  private async log(id: string, line: string): Promise<void> {
    await appendFile(join(this.areaDir(id), "log.txt"), line + "\n", "utf8").catch(() => {});
  }

  /** Append a raw output chunk (no newline added) to log.txt for live tailing. */
  private async streamChunk(id: string, chunk: string): Promise<void> {
    await appendFile(join(this.areaDir(id), "log.txt"), chunk, "utf8").catch(() => {});
  }

  private async stopRequested(id: string): Promise<boolean> {
    try {
      await stat(taskStopRequestPath(this.deps.root, id));
      return true;
    } catch {
      return false;
    }
  }

  private async assertNotStopped(id: string): Promise<void> {
    if (await this.stopRequested(id)) throw new Error("Task stopped by user");
  }

  /**
   * Run one pipeline step, streaming its output to log.txt as it arrives so the
   * UI's live-log view updates in real time. Writes a `### Label` header first,
   * then forwards every tool chunk to log.txt (live-output spec).
   */
  private async runStep(
    id: string,
    label: string,
    tool: Tool,
    opts: RunOptions,
  ): Promise<RunResult> {
    await this.assertNotStopped(id);
    await this.log(id, `\n### ${label}`);
    return tool.run({
      ...opts,
      stopSignalPath: taskStopRequestPath(this.deps.root, id),
      onChunk: (c) => void this.streamChunk(id, c),
    });
  }

  private tool(
    task: Task,
    role: "planner" | "developer" | "reviewer",
  ): { tool: Tool; model: string } {
    const assignment = resolveRole(this.deps.settings, task, role);
    return { tool: this.deps.registry.require(assignment.tool), model: assignment.model };
  }

  /** The observer's tool+model, or null when no observer is configured. */
  private observerTool(task: Task): { tool: Tool; model: string } | null {
    const assignment = resolveRole(this.deps.settings, task, "observer");
    if (!assignment) return null;
    return { tool: this.deps.registry.require(assignment.tool), model: assignment.model };
  }

  /**
   * Diff text for a prompt, capped at settings.review.maxInlineDiffBytes (larger
   * diffs inline only --stat, untracked files and a how-to-read note).
   */
  private async inlineDiff(id: string, worktree: Worktree | null): Promise<string> {
    if (!worktree) return "(no git diff available)";
    const max = reviewSettings(this.deps.settings).maxInlineDiffBytes;
    const diff = await diffAgainstBase(worktree, max);
    if (diff.capped) {
      await this.log(
        id,
        `Diff exceeds inline limit (${diff.bytes} > ${max} bytes); inlined --stat only (base ${diff.baseSha})`,
      );
    }
    return diff.text;
  }

  /**
   * List attached images/PDFs as absolute paths so the agent can open them in
   * place (the files live under tasks/assets/<id>/ and outlive the worktree).
   */
  private attachmentsSection(task: Task): string | null {
    const items = task.frontmatter.attachments ?? [];
    if (items.length === 0) return null;
    const lines = items.map(
      (a) => `- ${taskAssetPath(this.deps.root, task.frontmatter.id, a.name)} (${a.type})`,
    );
    return (
      "## Attachments\n" +
      "The user attached the following files. Open and read them for additional " +
      "context (they are images or PDFs):\n" +
      lines.join("\n")
    );
  }

  private async injectedPromptsSection(task: Task): Promise<string | null> {
    const text = await readFile(
      taskPromptInjectionsPath(this.deps.root, task.frontmatter.id),
      "utf8",
    ).catch(() => "");
    const trimmed = text.trim();
    if (!trimmed) return null;
    return (
      "## User prompts injected while this task was running\n" +
      "Apply these additional user instructions in this and later steps:\n" +
      trimmed
    );
  }

  private async buildPrompt(task: Task, extra: string): Promise<string> {
    const parts = [`# Task: ${task.frontmatter.title}`, `## Prompt\n${task.body.prompt}`];
    if (task.body.command.trim()) parts.push(`## Command\n${task.body.command}`);
    const attachments = this.attachmentsSection(task);
    if (attachments) parts.push(attachments);
    if (task.frontmatter.questions === "answered" && task.body.answers.trim()) {
      parts.push(`## Answers to earlier questions\n${task.body.answers}`);
    }
    const injected = await this.injectedPromptsSection(task);
    if (injected) parts.push(injected);
    const framing = iterationFraming(task);
    if (framing) parts.push(framing);
    if (extra) parts.push(extra);
    return parts.join("\n\n");
  }

  /**
   * Run the full pipeline for a task that is already in `running` status with a
   * working area created. Returns the outcome; the engine performs the final
   * status transition based on it.
   */
  async run(task: Task): Promise<PipelineOutcome> {
    const id = task.frontmatter.id;
    const usages: TokenUsage[] = [];
    const record = (r: RunResult) => {
      if (r.usage) usages.push(r.usage);
    };

    // Append-only log mirrored into the task body so the agent output stays
    // visible after the run ends (the UI reads it
    // from the task file). Writes to log.txt for live tailing too.
    const logLines: string[] = task.body.log ? [task.body.log] : [];
    // Record a block into the in-memory body log (the durable record saved to
    // the task file). Step output is streamed to log.txt live by runStep, so
    // these blocks are NOT re-written there to avoid duplication.
    const recordBody = (block: string): void => {
      logLines.push(block);
      task.body.log = logLines.join("\n\n");
    };
    // Status/worktree/error lines: record to the body AND write to log.txt so
    // they show up in the live tail too.
    const appendLog = async (line: string): Promise<void> => {
      recordBody(line);
      await this.log(id, line);
    };

    let worktree: Worktree | null = null;
    const { workingDirectory } = this.deps.settings;
    const cwd = workingDirectory;

    try {
      // Set up isolation when the working directory is a git repo. Reused
      // across iterations so later runs build on the prior run's work.
      if (await isGitRepo(workingDirectory)) {
        worktree = await ensureWorktree(workingDirectory, id);
        await appendLog(
          `Iteration ${currentIteration(task)}/${task.frontmatter.runs} — worktree at ${worktree.path}`,
        );
      } else {
        await appendLog(
          `WARNING: workingDirectory is not a git repo (${workingDirectory}); running without isolation.`,
        );
      }
      const stepCwd = worktree?.path ?? cwd;
      // Round entries are appended per iteration; start each run with a clean slate.
      task.body.reports.observer = "";
      task.body.reports.reviewer = "";

      // --- Step 1: Planner ---
      const planner = this.tool(task, "planner");
      const planResult = await this.runStep(id, "Planner", planner.tool, {
        role: "planner",
        model: planner.model,
        systemPrompt: SYSTEM_PROMPTS.planner,
        prompt: await this.buildPrompt(task, ""),
        cwd: stepCwd,
        autoApprove: true,
      });
      record(planResult);
      recordBody(`### Planner\n${planResult.output}`);

      // Park if the planner raised questions (and they aren't already answered).
      if (
        planResult.questions &&
        planResult.questions.length > 0 &&
        task.frontmatter.questions !== "answered"
      ) {
        // Keep the worktree: the task will resume here, and any prior-iteration
        // work must survive until the task finally completes.
        await this.mirrorLiveLog(task).catch(() => {});
        await this.persistUsage(task, usages);
        return { kind: "parked", task, questions: planResult.questions };
      }

      await writeFile(join(this.areaDir(id), "plan.md"), planResult.report + "\n", "utf8");
      await this.writeReport(task, "planner", planResult.report);

      // --- Step 2: Planner refinement pass (always run) ---
      const refineResult = await this.runStep(id, "Planner (refinement)", planner.tool, {
        role: "planner",
        model: planner.model,
        systemPrompt: SYSTEM_PROMPTS.refine,
        prompt: await this.buildPrompt(task, `## Existing plan\n${planResult.report}`),
        cwd: stepCwd,
        autoApprove: true,
      });
      record(refineResult);
      recordBody(`### Planner (refinement)\n${refineResult.output}`);
      await writeFile(join(this.areaDir(id), "plan.md"), refineResult.report + "\n", "utf8");
      await this.writeReport(
        task,
        "planner",
        `${planResult.report}\n\n## Refinement\n${refineResult.report}`,
      );
      const finalPlan = refineResult.report;

      // --- Step 3: Developer ---
      const developer = this.tool(task, "developer");
      let devResult = await this.runStep(id, "Developer", developer.tool, {
        role: "developer",
        model: developer.model,
        systemPrompt: SYSTEM_PROMPTS.developer,
        prompt: await this.buildPrompt(task, `## Plan\n${finalPlan}`),
        cwd: stepCwd,
        autoApprove: true,
      });
      record(devResult);
      recordBody(`### Developer\n${devResult.output}`);

      // Developer questions are routed to the planner via file, never the user.
      if (devResult.questions && devResult.questions.length > 0) {
        devResult = await this.answerViaPlanner(
          task,
          planner,
          "developer",
          devResult,
          stepCwd,
          finalPlan,
          usages,
        );
      }
      await this.writeReport(task, "developer", devResult.report);

      // --- Step 4: Observer (optional) and Reviewer, gated by verdicts ---
      const observer = this.observerTool(task);
      const reviewer = this.tool(task, "reviewer");
      const { gate, maxFixRounds } = reviewSettings(this.deps.settings);
      const checkRole = async (role: "observer" | "reviewer", round: number) => {
        const who = role === "observer" ? observer! : reviewer;
        const label = role === "observer" ? "Observer" : "Reviewer";
        const diff = await this.inlineDiff(id, worktree);
        let result = await this.runStep(id, `${label} (round ${round})`, who.tool, {
          role,
          model: who.model,
          systemPrompt: SYSTEM_PROMPTS[role],
          prompt: await this.buildPrompt(
            task,
            `## Plan\n${finalPlan}\n\n## Diff under review\n${diff}`,
          ),
          cwd: stepCwd,
          autoApprove: true,
        });
        record(result);
        recordBody(`### ${label} (round ${round})\n${result.output}`);
        // Parse before the planner dialogue is appended, so only the agent's own
        // final line counts.
        const verdict = parseVerdict(result.report);
        if (result.questions && result.questions.length > 0) {
          result = await this.answerViaPlanner(
            task,
            planner,
            role,
            result,
            stepCwd,
            finalPlan,
            usages,
          );
        }
        await this.appendRoundReport(task, role, round, verdict, result.report);
        await appendLog(`${label} verdict (round ${round}): ${verdict ?? "INVALID"}`);
        return { verdict, report: result.report };
      };
      const fix = async (
        fixRound: number,
        role: "observer" | "reviewer",
        sourceRound: number,
        findings: string,
      ) => {
        const diff = await this.inlineDiff(id, worktree);
        let fixResult = await this.runStep(
          id,
          `Developer (fix round ${fixRound}, ${role})`,
          developer.tool,
          {
            role: "developer",
            model: developer.model,
            systemPrompt: SYSTEM_PROMPTS.developerFix,
            prompt: await this.buildPrompt(
              task,
              `## Plan\n${finalPlan}\n\n## Findings (${role} round ${sourceRound})\n${findings}\n\n` +
                `## Instructions\nFix each real finding with a test, or rebut it with evidence.\n\n` +
                `## Current diff\n${diff}`,
            ),
            cwd: stepCwd,
            autoApprove: true,
          },
        );
        record(fixResult);
        recordBody(`### Developer (fix round ${fixRound}, ${role})\n${fixResult.output}`);
        if (fixResult.questions && fixResult.questions.length > 0) {
          fixResult = await this.answerViaPlanner(
            task,
            planner,
            "developer",
            fixResult,
            stepCwd,
            finalPlan,
            usages,
          );
        }
        await this.writeReport(
          task,
          "developer",
          `${task.body.reports.developer}\n\n#### Fix round ${fixRound} (${role})\n${fixResult.report}`,
        );
      };

      // The observer budget is shared across the run; the reviewer has its own.
      let obsFix = 0;
      let revFix = 0;
      let obsRound = 0;
      let revRound = 0;
      for (;;) {
        if (observer) {
          for (;;) {
            const obs = await checkRole("observer", ++obsRound);
            if (!gate || obs.verdict === "APPROVE") break;
            if (obs.verdict !== "CHANGES_REQUESTED" || obsFix >= maxFixRounds) {
              throw new ReviewNotApprovedError("observer", obs.verdict);
            }
            await fix(++obsFix, "observer", obsRound, obs.report);
          }
        }
        const rev = await checkRole("reviewer", ++revRound);
        if (!gate || rev.verdict === "APPROVE") break;
        if (rev.verdict !== "CHANGES_REQUESTED" || revFix >= maxFixRounds) {
          throw new ReviewNotApprovedError("reviewer", rev.verdict);
        }
        await fix(++revFix, "reviewer", revRound, rev.report);
      }

      // Only finalize the worktree on the final iteration (leftovers are
      // committed, then just the directory is removed; the branch is kept).
      // Intermediate runs keep it so the next run continues from this output.
      if (worktree && isFinalIteration(task)) {
        for (const line of await finalizeWorktree(
          workingDirectory,
          worktree,
          task.frontmatter.title,
        )) {
          await appendLog(line);
        }
        await appendLog(
          `Task branch ${worktree.branch} at ${await branchHead(workingDirectory, worktree.branch)}`,
        );
      }
      await this.mirrorLiveLog(task);
      await this.persistUsage(task, usages);
      return { kind: "done", task };
    } catch (err) {
      const message =
        err instanceof ReviewNotApprovedError
          ? err.message
          : err instanceof Error
            ? `${err.name}: ${err.message}`
            : String(err);
      // Capture the failing tool's captured output (stdout/stderr) when present,
      // so the Log tab shows *why* it failed even after the run ends.
      const detail = (err as { output?: string })?.output;
      await appendLog(`ERROR: ${message}${detail ? `\n${detail}` : ""}`);
      if (worktree) {
        const sha = await branchHead(workingDirectory, worktree.branch).catch(() => "(unknown)");
        await appendLog(
          `Kept worktree ${worktree.path} on branch ${worktree.branch} at ${sha}`,
        ).catch(() => {});
      }
      await this.mirrorLiveLog(task).catch(() => {});
      await this.persistUsage(task, usages).catch(() => {});
      return { kind: "failed", task, error: message };
    }
  }

  /**
   * Route a developer/reviewer question to the planner and capture the written
   * back-and-forth in the task dir (runner-pipeline spec 6.6). Returns a result
   * carrying the original report plus the recorded dialogue, never parking.
   */
  private async answerViaPlanner(
    task: Task,
    planner: { tool: Tool; model: string },
    fromRole: "developer" | "observer" | "reviewer",
    result: RunResult,
    cwd: string,
    plan: string,
    usages: TokenUsage[],
  ): Promise<RunResult> {
    const id = task.frontmatter.id;
    const questions = result.questions ?? [];
    const answer = await this.runStep(id, `Planner (answering ${fromRole})`, planner.tool, {
      role: "planner",
      model: planner.model,
      systemPrompt:
        "You are the PLANNER. Answer the following questions from the " +
        `${fromRole} using the plan and task context. Do not escalate to the user.`,
      prompt: await this.buildPrompt(
        task,
        `## Plan\n${plan}\n\n## ${fromRole} questions\n${questions.join("\n")}`,
      ),
      cwd,
      autoApprove: true,
    });
    if (answer.usage) usages.push(answer.usage);
    const dialogue = [
      `# ${fromRole} ↔ planner dialogue`,
      `## ${fromRole} asked`,
      questions.join("\n"),
      `## planner answered`,
      answer.report,
    ].join("\n\n");
    await writeFile(join(this.areaDir(id), `dialogue-${fromRole}.md`), dialogue + "\n", "utf8");
    await this.log(id, `Routed ${fromRole} questions to planner (resolved via file).`);
    return { ...result, questions: undefined, report: `${result.report}\n\n${dialogue}` };
  }

  /**
   * Write a step report to reports/<role>.md AND mirror it into the task body's
   * `## Reports` section. The working area under ongoing/ is removed when the
   * task moves to done/, so the body mirror is the durable record.
   */
  private async writeReport(
    task: Task,
    role: "planner" | "developer" | "observer" | "reviewer",
    content: string,
  ): Promise<void> {
    const id = task.frontmatter.id;
    await mkdir(join(this.areaDir(id), "reports"), { recursive: true });
    await writeFile(join(this.areaDir(id), "reports", `${role}.md`), content + "\n", "utf8");
    task.body.reports[role] = content;
  }

  /**
   * Append one observer/reviewer round (with its verdict) to the task's report
   * for that role, and write reports/<role>-round-N.md.
   */
  private async appendRoundReport(
    task: Task,
    role: "observer" | "reviewer",
    round: number,
    verdict: Verdict | null,
    report: string,
  ): Promise<void> {
    const id = task.frontmatter.id;
    await mkdir(join(this.areaDir(id), "reports"), { recursive: true });
    await writeFile(
      join(this.areaDir(id), "reports", `${role}-round-${round}.md`),
      report + "\n",
      "utf8",
    );
    const entry = `#### Round ${round} — ${verdict ?? "INVALID"}\n${report}`;
    const prior = task.body.reports[role];
    await this.writeReport(task, role, prior ? `${prior}\n\n${entry}` : entry);
  }

  /** Persist per-task token usage onto the task file and the global aggregate. */
  private async persistUsage(task: Task, usages: TokenUsage[]): Promise<void> {
    const total = sumUsage(usages);
    task.frontmatter.tokens = total;
    await this.deps.store.save(task);
    await this.usageStore.add(total);
  }

  private async mirrorLiveLog(task: Task): Promise<void> {
    const text = await readFile(join(this.areaDir(task.frontmatter.id), "log.txt"), "utf8");
    if (text.trim()) task.body.log = text;
  }
}
