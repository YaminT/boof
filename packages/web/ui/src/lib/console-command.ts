import type { Scope } from "@boof-runner/shared/schema";
import type { CommandAction } from "./command-actions.js";

export type ConsoleResolution =
  | { kind: "run"; action: CommandAction; args: string }
  | { kind: "unknown"; input: string; reason?: string };

export type ConsoleOutcome =
  | { kind: "ok"; action: CommandAction }
  | { kind: "error"; action: CommandAction; message: string }
  | { kind: "unknown"; input: string; reason?: string };

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Actions the held scopes allow. "all" means the server will be the judge. */
export function availableActions(
  actions: CommandAction[],
  held: ReadonlySet<Scope> | "all",
): CommandAction[] {
  if (held === "all") return actions;
  return actions.filter((a) => {
    if (!a.requiredScope) return true;
    const need = Array.isArray(a.requiredScope) ? a.requiredScope : [a.requiredScope];
    return need.some((s) => held.has(s));
  });
}

const unknown = (input: string, reason: string): ConsoleResolution => ({
  kind: "unknown",
  input,
  reason,
});

/** Slash verbs that take a target: the id prefix of the actions they pick from. */
const TARGETED: Record<string, string> = {
  queue: "queue-",
  stop: "stop-",
  open: "open-task-",
  activate: "activate-plan-",
  project: "switch-project-",
};

function pickTarget(
  raw: string,
  verb: string,
  args: string,
  actions: CommandAction[],
): ConsoleResolution {
  const candidates = actions.filter((a) => a.id.startsWith(TARGETED[verb]!));
  const want = norm(args);
  if (!want) return unknown(raw, `/${verb} needs a target: which one?`);
  const byId = candidates.filter((a) => a.id.slice(TARGETED[verb]!.length).toLowerCase() === want);
  const hits = byId.length
    ? byId
    : candidates.filter((a) => norm(`${a.label} ${a.searchValue}`).includes(want));
  if (hits.length === 1) return { kind: "run", action: hits[0]!, args };
  return unknown(
    raw,
    hits.length === 0
      ? `no match for "${args.trim()}"`
      : `more than one match for "${args.trim()}"`,
  );
}

function slash(raw: string, actions: CommandAction[]): ConsoleResolution {
  const head = raw.slice(1).split(/\s+/)[0] ?? "";
  const verb = head.toLowerCase();
  const args = raw.slice(1 + head.length).trim();
  const byId = (id: string) => actions.find((a) => a.id === id);
  const run = (a: CommandAction | undefined, what: string): ConsoleResolution =>
    a ? { kind: "run", action: a, args } : unknown(raw, `${what} is not available here`);

  if (verb === "task") return run(byId("new-task"), "/task");
  if (verb in TARGETED) return pickTarget(raw, verb, args, actions);
  if (verb === "go") {
    const want = norm(args);
    if (!want) return unknown(raw, "/go needs a page: which one?");
    const hits = actions.filter(
      (a) => a.id.startsWith("go-") && a.id.slice(3).replace("settings-", "settings ") === want,
    );
    return hits.length === 1
      ? { kind: "run", action: hits[0]!, args }
      : unknown(raw, `no page "${args}"`);
  }
  if (verb === "theme") return run(byId(`theme-${norm(args)}`), `theme "${args}"`);
  if (verb === "runner") {
    const a = byId("toggle-runner");
    const want = norm(args);
    // The action flips the state, so only run it when that is what was asked.
    if (
      a &&
      ((want === "pause" && a.label.startsWith("Pause")) ||
        (want === "start" && a.label.startsWith("Start")))
    )
      return { kind: "run", action: a, args };
    return unknown(
      raw,
      a
        ? `the runner is already ${want === "pause" ? "paused" : "running"}, or say pause/start`
        : "/runner is not available here",
    );
  }
  return unknown(raw, "no such command");
}

/** Turns what the user typed into one registered action. No guessing: anything unclear is unknown. */
export function resolveConsoleCommand(input: string, actions: CommandAction[]): ConsoleResolution {
  const raw = input.trim();
  if (!raw) return { kind: "unknown", input: "", reason: "nothing typed" };
  if (raw.startsWith("/")) return slash(raw, actions);

  const want = norm(raw);
  const exact = actions.filter((a) => norm(a.label) === want || a.id === want);
  if (exact.length === 1) return { kind: "run", action: exact[0]!, args: "" };

  // Fuzzy words only reach actions that change nothing (navigation, theme).
  const words = want.split(" ");
  const fuzzy = actions.filter(
    (a) =>
      !a.requiredScope &&
      words.every((w) => norm(`${a.label} ${a.searchValue} ${a.keywords.join(" ")}`).includes(w)),
  );
  if (fuzzy.length === 1) return { kind: "run", action: fuzzy[0]!, args: "" };
  return unknown(raw, fuzzy.length > 1 ? "more than one match" : "no such command");
}

/** One line of output per outcome; the same input always reads the same. */
export function formatConsoleResult(o: ConsoleOutcome): string {
  if (o.kind === "ok") return `ok: ${o.action.label}`;
  if (o.kind === "error") return `error: ${o.action.label}: ${o.message}`;
  return `unknown: "${o.input}"${o.reason ? ` (${o.reason})` : ""}. Try a palette label or /task, /queue, /stop, /open, /go.`;
}
