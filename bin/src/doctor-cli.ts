import { spawn } from "node:child_process";
import { chmod, mkdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  expandHome,
  OwlishSettingsSchema,
  resolveProjectsRoot,
  SecuritySettingsSchema,
} from "@boof/heart";
import type { HarnessStatusResult, TaskService } from "@boof/heart-server";

type DoctorCheck = HarnessStatusResult["checks"][number];

export const DOCTOR_HELP = `boof doctor — check this computer, and fix what is missing

Usage:
  boof doctor [--json] [-d <data>]
  boof doctor --fix [--yes] [-d <data>]

Prints the same checks as the Doctor in the web app: the coding agents (ready or not, and why),
the better-ccflare gateway, the projects folder, git, the data folder and the sandbox.
Free: it never sends a prompt. Exit 0 when boof can work (an agent is ready), 1 when it cannot,
2 for a usage error (a typo, a bad flag) or when --fix has no terminal.

--fix walks the checks that need attention, one at a time, and asks before it does anything. It
needs an interactive terminal (exit 2 without one). Install commands are printed; an npm install
runs only after you answer y. boof never runs sudo. Secrets are typed hidden and stored where boof
already keeps them (mode 0600).
--yes accepts the safe defaults (create the projects folder, make the data folder private) and
never an install, a secret, or a change to which folders API clients may use.`;

/** The part of the server's service the doctor uses. Tests pass a real one over a scratch folder. */
export type DoctorService = Pick<
  TaskService,
  | "root"
  | "harnesses"
  | "loadSettings"
  | "updateSettings"
  | "settingsStore"
  | "owlishSecrets"
  | "projectKeys"
  | "listProjects"
>;

/** Terminal access. Tests pass a scripted one. */
export interface DoctorIo {
  isTTY: boolean;
  out(line: string): void;
  err(line: string): void;
  /** One answer; `hidden` input is never echoed. */
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  /** Runs an install command with the terminal attached; resolves with its exit code. */
  run(command: string, args: readonly string[]): Promise<number>;
  close(): void;
}

export interface DoctorDeps {
  service: (root: string) => DoctorService;
  defaultRoot: () => string;
  io?: DoctorIo;
  platform?: NodeJS.Platform;
  /** Whether `npm` can be run (for the install offer). */
  hasNpm?: () => Promise<boolean>;
}

const MARK = { pass: "✓", warn: "!", fail: "✗" } as const;

/** The npm packages of the agents that install with npm (the same commands as the web Agents page). */
const NPM_PACKAGE: Record<string, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
};

/** Why boof cannot work, or null: no agent is ready, or git or the data folder hard-fails. */
export function blockReason(status: HarnessStatusResult): string | null {
  if (!status.anyReady) return "Cannot run tasks yet: no coding agent is ready";
  const hard = status.checks.find(
    (c) => c.status === "fail" && (c.id === "git" || c.id === "dataRoot"),
  );
  return hard ? `Cannot run tasks yet: ${hard.label} is not usable` : null;
}

function needsAttention(status: HarnessStatusResult): boolean {
  return status.checks.some(
    (c) =>
      c.status === "fail" ||
      (c.status === "warn" &&
        !(c.id === "gateway" && status.anyReady && c.message === "Not configured.")),
  );
}

function compactSummary(status: HarnessStatusResult): string {
  const n = Object.values(status.tools).filter((t) => t.ready).length;
  const gw = status.checks.find((c) => c.id === "gateway");
  const gateway = !gw || gw.status === "pass" ? "gateway OK" : "gateway not configured (optional)";
  return `Doctor: OK · ${n} agent${n === 1 ? "" : "s"} ready · ${gateway}`;
}

/** The table, in the order and words of the web Doctor. */
export function renderDoctor(status: HarnessStatusResult): string[] {
  const lines = ["Doctor", ""];
  const reason = blockReason(status);
  const clean = !status.checks.some((c) => c.status !== "pass");
  lines.push(
    reason ?? (clean ? "All set" : "All set: an agent is ready"),
    ...(reason || needsAttention(status) ? [] : [compactSummary(status)]),
    "",
  );
  const width = Math.max(...status.checks.map((c) => c.label.length));
  for (const c of status.checks) {
    lines.push(`${MARK[c.status]} ${c.label.padEnd(width)}  ${c.message}`);
    if (c.status !== "pass" && c.fixHint) lines.push(`  ${" ".repeat(width)}  ${c.fixHint}`);
  }
  lines.push("", "Coding agents");
  for (const [id, t] of Object.entries(status.tools)) {
    lines.push(
      `${t.ready ? MARK.pass : MARK.fail} ${id.padEnd(14)} ${t.displayName}: ${t.ready ? "ready" : "not ready"} — ${t.readyReason}`,
    );
    if (!t.ready && t.fixHint) lines.push(`  ${" ".repeat(14)} ${t.fixHint}`);
  }
  return lines;
}

/** The user pressed Ctrl-C or Ctrl-D at a question. */
export class DoctorCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** The command and options to run npm: on Windows it is a .cmd file, which needs a shell. */
function npmSpawn(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; shell: boolean } {
  return command === "npm" && platform === "win32"
    ? { command: "npm.cmd", shell: true }
    : { command, shell: false };
}

/** A real terminal: readline over stdin/stdout; hidden answers are swallowed before they echo. */
export function terminalIo(): DoctorIo {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  // historySize 0: readline's history would bring a hidden answer (a key) back with the Up arrow.
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  let cancel: (() => void) | undefined;
  const onCancel = () => {
    muted = false;
    cancel?.();
  };
  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    rl.close();
  });
  rl.on("close", onCancel);
  return {
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    ask: (question, opts) =>
      new Promise<string>((done, fail) => {
        cancel = () => fail(new DoctorCancelled());
        process.stdout.write(question);
        muted = opts?.hidden === true;
        rl.question("", (answer) => {
          muted = false;
          cancel = undefined;
          if (opts?.hidden) process.stdout.write("\n");
          done(answer);
        });
      }),
    run: (command, args) =>
      new Promise<number>((done) => {
        const n = npmSpawn(command);
        try {
          const child = spawn(n.command, [...args], { stdio: "inherit", shell: n.shell });
          child.on("error", () => done(127));
          child.on("close", (code) => done(code ?? 1));
        } catch {
          done(127);
        }
      }),
    close: () => {
      rl.off("close", onCancel);
      rl.close();
    },
  };
}

async function npmAvailable(): Promise<boolean> {
  return new Promise((done) => {
    const n = npmSpawn("npm");
    try {
      const child = spawn(n.command, ["--version"], { stdio: "ignore", shell: n.shell });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());

interface Ctx {
  svc: DoctorService;
  io: DoctorIo;
  assumeYes: boolean;
  platform: NodeJS.Platform;
  hasNpm: () => Promise<boolean>;
}

function gitInstallHelp(platform: NodeJS.Platform): string[] {
  if (platform === "darwin")
    return ["Install git with Homebrew: brew install git (or run: xcode-select --install)."];
  if (platform === "win32")
    return ["Install git with: winget install --id Git.Git (or from https://git-scm.com)."];
  return [
    "Install git with your package manager, for example:",
    "  Debian/Ubuntu: sudo apt install git",
    "  Fedora:        sudo dnf install git",
    "  Arch:          sudo pacman -S git",
    "boof does not run sudo for you.",
  ];
}

async function fixAgents(ctx: Ctx, status: HarnessStatusResult): Promise<void> {
  const { io } = ctx;
  for (const [id, tool] of Object.entries(status.tools)) {
    if (tool.ready || tool.installed) continue;
    io.out(`\n${tool.displayName} (${id}) is not installed: ${tool.readyReason}`);
    const pkg = NPM_PACKAGE[id];
    if (!pkg) {
      io.out(tool.fixHint ?? "Install it, then run the Doctor again.");
      continue;
    }
    const command = `npm install -g ${pkg}`;
    io.out(`To install it, run: ${command}`);
    if (!(await ctx.hasNpm())) {
      io.out("npm was not found; install Node.js with npm first, or install it another way.");
      continue;
    }
    if (ctx.assumeYes) {
      io.out("(--yes never installs anything.)");
      continue;
    }
    if (!yes(await io.ask(`Run "${command}" now? [y/N] `))) continue;
    const code = await io.run("npm", ["install", "-g", pkg]);
    if (code !== 0)
      io.out(
        `The install failed (exit ${code}). If it was a permissions error, point npm at a folder you own ` +
          `(npm config set prefix ~/.local) and run it again. boof never runs sudo.`,
      );
  }
}

async function fixGateway(ctx: Ctx, check: DoctorCheck): Promise<void> {
  const { io, svc } = ctx;
  io.out(`\n${check.label}: ${check.message}`);
  io.out(
    "The gateway shares your Claude accounts between tasks. It is optional while a coding agent works without it.\n" +
      "You can give boof its address (and its client key), or an Anthropic API key for one project.",
  );
  if (ctx.assumeYes) {
    io.out("(--yes never enters a key or an address.)");
    return;
  }
  if (!yes(await io.ask("Set this up now? [y/N] "))) return;
  const choice = (await io.ask("1 = gateway address, 2 = Anthropic API key (Enter to skip): "))
    .trim()
    .toLowerCase();
  if (choice === "1") {
    const url = (
      await io.ask("better-ccflare gateway URL (for example http://localhost:8080): ")
    ).trim();
    if (!url) return;
    const current = (await svc.loadSettings()).owlish;
    const parsed = OwlishSettingsSchema.safeParse({
      url,
      healthGate: current?.healthGate ?? "pause",
    });
    if (!parsed.success) {
      io.out(`That address is not accepted: ${parsed.error.issues[0]?.message ?? "invalid URL"}`);
      return;
    }
    const key = (
      await io.ask("Gateway client key (hidden; Enter to keep the current one): ", {
        hidden: true,
      })
    ).trim();
    if (key) {
      try {
        await svc.owlishSecrets.set(key);
      } catch (e) {
        io.out(`The key was not saved: ${e instanceof Error ? e.message : "invalid key"}`);
        return;
      }
    }
    await svc.updateSettings({ owlish: parsed.data });
    io.out(`Saved the gateway address${key ? " and key" : ""}.`);
  } else if (choice === "2") {
    const projects = (await svc.listProjects()).filter((p) => !p.archived);
    if (projects.length === 0) {
      io.out(
        "An API key belongs to a project, and there is none yet. Add a project first, then run this again.",
      );
      return;
    }
    let id = projects[0]!.id;
    if (projects.length > 1) {
      id = (await io.ask(`Project (${projects.map((p) => p.id).join(", ")}): `)).trim();
      if (!projects.some((p) => p.id === id)) {
        io.out("No such project.");
        return;
      }
    }
    const key = (await io.ask(`Anthropic API key for ${id} (hidden): `, { hidden: true })).trim();
    if (!key) return;
    try {
      await svc.projectKeys.set(id, key);
    } catch (e) {
      io.out(`The key was not saved: ${e instanceof Error ? e.message : "invalid key"}`);
      return;
    }
    io.out(`Saved the API key for ${id}.`);
  }
}

async function fixProjectsRoot(ctx: Ctx, check: DoctorCheck): Promise<void> {
  const { io, svc } = ctx;
  io.out(`\n${check.label}: ${check.message}`);
  const settings = await svc.loadSettings();
  const suggested = resolveProjectsRoot(settings);
  io.out(`boof keeps the projects it creates in this folder (default ${suggested}).`);
  if (!ctx.assumeYes && !yes(await io.ask("Create it and save it as your projects folder? [y/N] ")))
    return;
  let path = suggested;
  if (!ctx.assumeYes) {
    const typed = (await io.ask(`Folder [${suggested}]: `)).trim();
    if (typed) path = isAbsolute(expandHome(typed)) ? expandHome(typed) : "";
    if (!path) {
      io.out("Use an absolute path (or one starting with ~/).");
      return;
    }
  }
  path = resolve(path);
  const refused = await refuseProjectsRoot(path, svc.root);
  if (refused) {
    io.out(`Not saved: ${refused}`);
    return;
  }
  try {
    const existed = await stat(path).then(
      (s) => s.isDirectory(),
      () => false,
    );
    await mkdir(path, { recursive: true, mode: 0o700 });
    // Only a folder this run created is made private; an existing (maybe shared) one is left as it is.
    if (!existed) await chmod(path, 0o700).catch(() => undefined);
    const security = SecuritySettingsSchema.parse(settings.security ?? {});
    // Letting API clients register and create projects here is a security setting: ask on its own,
    // and never under --yes.
    let widen = false;
    if (ctx.assumeYes) io.out("(--yes does not change which folders API clients may use.)");
    else {
      widen = yes(
        await io.ask(
          `Also let API clients register and create projects inside ${path} (adds it to security.allowedProjectRoots)? [y/N] `,
        ),
      );
    }
    await svc.settingsStore.update({
      projectsRoot: path,
      ...(widen
        ? {
            security: {
              ...security,
              allowedProjectRoots: [...new Set([...security.allowedProjectRoots, path])],
            },
          }
        : {}),
    });
    io.out(
      `${existed ? "Using" : "Created"} ${path} and saved it as the projects folder${widen ? ", and added it to the folders API clients may use" : ""}.`,
    );
  } catch (e) {
    io.out(`Could not set it up: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const sameOrInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Why `path` cannot be the projects folder (the rule of assertRegistrationAllowed), or null. */
async function refuseProjectsRoot(path: string, dataRoot: string): Promise<string | null> {
  // Resolve through the deepest existing parent (a folder not made yet still sits behind symlinks).
  const real = async (p: string): Promise<string> => {
    try {
      return await realpath(p);
    } catch {
      const up = dirname(p);
      return up === p ? p : join(await real(up), basename(p));
    }
  };
  const target = await real(path);
  if (dirname(target) === target) return "the filesystem root cannot be the projects folder.";
  if (target === (await real(homedir())))
    return "the home folder itself cannot be the projects folder; choose a folder inside it.";
  if (sameOrInside(await real(dataRoot), target))
    return "the data folder (or a folder inside it) cannot be the projects folder.";
  return null;
}

async function fixDataRoot(ctx: Ctx, check: DoctorCheck): Promise<void> {
  const { io, svc } = ctx;
  io.out(`\n${check.label}: ${check.message}`);
  const exists = await stat(svc.root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  io.out(
    exists
      ? `boof can make ${svc.root} private to you (chmod 700).`
      : `${svc.root} does not exist; boof can create it, private to you (mode 700).`,
  );
  if (!ctx.assumeYes && !yes(await io.ask("Do it? [y/N] "))) return;
  try {
    if (!exists) await mkdir(svc.root, { recursive: true, mode: 0o700 });
    await chmod(svc.root, 0o700);
    io.out("Done.");
  } catch (e) {
    io.out(
      `That did not work: ${e instanceof Error ? e.message : String(e)}. Choose a folder you own with -d.`,
    );
  }
}

async function walk(ctx: Ctx, status: HarnessStatusResult): Promise<void> {
  const { io } = ctx;
  const todo = status.checks.filter((c) => c.status !== "pass");
  if (todo.length === 0) {
    io.out("\nNothing to fix.");
    return;
  }
  for (const check of todo) {
    switch (check.id) {
      case "agents":
        await fixAgents(ctx, status);
        break;
      case "gateway":
        await fixGateway(ctx, check);
        break;
      case "projectsRoot":
        await fixProjectsRoot(ctx, check);
        break;
      case "dataRoot":
        await fixDataRoot(ctx, check);
        break;
      case "git":
        io.out(`\n${check.label}: ${check.message}`);
        for (const l of gitInstallHelp(ctx.platform)) io.out(l);
        break;
      case "sandbox":
        io.out(`\n${check.label}: ${check.message}`);
        io.out(
          "Nothing to fix here; boof works without it. It is set up in Settings when your computer supports it.",
        );
        break;
    }
  }
}

function dataOption(args: readonly string[]): { data?: string; rest: string[]; bad?: string } {
  const rest: string[] = [];
  let data: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "-d" || a === "--data") {
      data = args[i + 1];
      if (!data || data.startsWith("-")) return { rest, bad: `${a} needs a folder` };
      i += 1;
    } else if (a.startsWith("--data=")) data = a.slice("--data=".length);
    else rest.push(a);
  }
  return { ...(data ? { data } : {}), rest };
}

/** `boof doctor` and `boof-runner doctor`: the Doctor checks in the terminal, and `--fix`. */
export async function doctorCommand(argv: readonly string[], deps: DoctorDeps): Promise<number> {
  const { data, rest, bad } = dataOption(argv);
  const words = rest.filter((a) => !a.startsWith("-"));
  const flags = rest.filter((a) => a.startsWith("-"));
  if (flags.includes("--help") || flags.includes("-h")) {
    console.log(DOCTOR_HELP);
    return 0;
  }
  const unknown = flags.filter((f) => !["--json", "--fix", "--yes", "-y"].includes(f));
  if (bad || unknown.length > 0 || words.length > 0) {
    console.error(bad ?? `unknown command: doctor ${[...words, ...unknown].join(" ")}`);
    return 2;
  }
  const json = flags.includes("--json");
  const fix = flags.includes("--fix");
  const assumeYes = flags.includes("--yes") || flags.includes("-y");
  if (assumeYes && !fix) {
    console.error("--yes only goes with --fix");
    return 2;
  }
  if (json && fix) {
    console.error("--json cannot be combined with --fix");
    return 2;
  }
  const root = data ? resolve(process.cwd(), data) : deps.defaultRoot();
  const svc = deps.service(root);

  if (!fix) {
    const status = await svc.harnesses(true);
    if (json) {
      console.log(
        JSON.stringify(
          { ok: blockReason(status) === null, blockReason: blockReason(status), ...status },
          null,
          2,
        ),
      );
    } else {
      for (const l of renderDoctor(status)) console.log(l);
    }
    return blockReason(status) === null ? 0 : 1;
  }

  const io = deps.io ?? terminalIo();
  try {
    if (!io.isTTY) {
      io.err(
        "boof doctor --fix asks questions, so it needs an interactive terminal. Run it in a terminal, or use `boof doctor` to only see the checks.",
      );
      return 2;
    }
    const ctx: Ctx = {
      svc,
      io,
      assumeYes,
      platform: deps.platform ?? process.platform,
      hasNpm: deps.hasNpm ?? npmAvailable,
    };
    const before = await svc.harnesses(true);
    for (const l of renderDoctor(before)) io.out(l);
    await walk(ctx, before);
    const after = await svc.harnesses(true);
    io.out("\nAfter the fixes:\n");
    for (const l of renderDoctor(after)) io.out(l);
    return blockReason(after) === null ? 0 : 1;
  } catch (e) {
    if (e instanceof DoctorCancelled) {
      io.err("\nCancelled. Nothing more was changed.");
      return 130;
    }
    throw e;
  } finally {
    io.close();
  }
}
