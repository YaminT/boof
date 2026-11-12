import type { CachedInstall } from "@boof/heart";

export const DOCTOR_HELP = `boof-runner doctor — see which coding agents are installed

Usage:
  boof-runner doctor [--json]

Prints each coding agent (harness) with its version and path, and the PATH boof looks in.
Free: it never sends a prompt. Exit 0 when at least one is installed, 1 when none is.`;

export interface DoctorCatalog {
  list(): readonly { id: string; displayName: string }[];
  installedAll(maxAgeMs?: number): Promise<Readonly<Record<string, Readonly<CachedInstall>>>>;
}

/** `boof-runner doctor`: the install check of every registered tool. */
export async function doctorCommand(
  argv: readonly string[],
  catalog: DoctorCatalog,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const words = argv.filter((a) => !a.startsWith("-"));
  const flags = argv.filter((a) => a.startsWith("-"));
  if (flags.includes("--help") || flags.includes("-h")) {
    console.log(DOCTOR_HELP);
    return 0;
  }
  const unknown = flags.filter((f) => f !== "--json");
  if (unknown.length > 0 || words.length > 0) {
    console.error(`unknown command: doctor ${[...words, ...unknown].join(" ")}`);
    return 1;
  }
  const installs = await catalog.installedAll(0);
  const tools = catalog.list().filter((t) => installs[t.id] !== undefined);
  const anyInstalled = tools.some((t) => installs[t.id]!.installed);
  const pathUsed = env.PATH ?? env.Path ?? "";
  if (flags.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          tools: Object.fromEntries(
            tools.map((t) => {
              const { checkedAt: _c, ...rest } = installs[t.id]!;
              return [t.id, { displayName: t.displayName, ...rest }];
            }),
          ),
          anyInstalled,
          path: pathUsed,
        },
        null,
        2,
      ),
    );
    return anyInstalled ? 0 : 1;
  }
  for (const t of tools) {
    const r = installs[t.id]!;
    const where = r.path ? `  ${r.path}` : "";
    const off = r.foundOffPath ? "  (not on PATH)" : "";
    console.log(
      `${r.installed ? "ok  " : "--  "} ${t.id.padEnd(14)} ${r.installed ? (r.version ?? "installed") : r.message}${where}${off}`,
    );
  }
  console.log(`\nPATH: ${pathUsed || "(empty)"}`);
  if (!anyInstalled) console.error("\nNo coding agent found. Install claude, codex or opencode.");
  return anyInstalled ? 0 : 1;
}
