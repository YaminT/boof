import { formatSandboxCheck, type SandboxCheckReport } from "@boof/runner";

const VALUE_FLAGS = new Set(["-d", "--data", "-p", "--port", "--host", "--tls-cert", "--tls-key"]);

export { formatSandboxCheck };

export const SANDBOX_HELP = `boof-runner sandbox — see whether enforce would work

Usage:
  boof-runner sandbox check

Prints the backend, the Landlock ABI, and each self-test probe.
Exit 0 only when enforce would work. A task agent is refused like any other command.`;

/**
 * `boof-runner sandbox`. `--help` and a bare `sandbox` print help and do not run the check.
 * Global value flags (`-d`, `--port`, ...) are skipped: routing leaves them at the end.
 */
export async function sandboxCommand(
  argv: readonly string[],
  assess: () => Promise<SandboxCheckReport>,
): Promise<number> {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      console.log(SANDBOX_HELP);
      return 0;
    }
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (VALUE_FLAGS.has(flag)) {
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      console.error(`unknown command: sandbox ${token}`);
      return 1;
    }
    words.push(token);
  }
  if (words.length === 0) {
    console.log(SANDBOX_HELP);
    return 0;
  }
  if (words[0] !== "check" || words.length > 1) {
    console.error(`unknown command: sandbox ${words.join(" ")}`);
    return 1;
  }
  const text = formatSandboxCheck(await assess());
  process.stdout.write(text.stdout);
  if (text.stderr) process.stderr.write(text.stderr);
  return text.code;
}
