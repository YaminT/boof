// Child for the CLI rate-limit race. Two of these call the CLI entry together.
// argv: <data root> <now ms>. Prints nothing on success. Exit 0 takes the slot; exit 1 is the limit.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  setCliRateHoldForTests,
  setCliRateNowForTests,
} from "../../packages/heart/src/cli-rate-limit.ts";
import { scriptedAgent } from "../../packages/heart-server/src/concierge/fake-agent.ts";
import { main } from "../src/boof-runner.ts";

const [root, now] = process.argv.slice(2);
const race = join(root, "race");
await mkdir(race, { recursive: true });

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

await writeFile(join(race, `ready-${process.pid}`), "");
await waitFor(join(race, "go"));

setCliRateNowForTests(() => Number(now));
setCliRateHoldForTests(async (phase) => {
  if (phase === "at-gate") {
    await writeFile(join(race, `gate-${process.pid}`), "");
    return;
  }
  await writeFile(join(race, `entered-${process.pid}`), "");
  await waitFor(join(race, "release"));
});
(globalThis as { __boofDevConcierge?: unknown }).__boofDevConcierge = scriptedAgent([
  { text: "ok" },
]);

try {
  await main(["concierge", "ask", "--project", "demo", "--text", "hello", "--json", "-d", root]);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
process.exit(process.exitCode ?? 0);
