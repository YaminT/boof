import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Start `serve -p 0`, return stdout up to the API line, then stop it. */
async function serveOutput(extraEnv: NodeJS.ProcessEnv, data: string, home: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(process.cwd(), "bin/src/boof-runner.ts"),
      "serve",
      "-d",
      data,
      "-p",
      "0",
      "--no-runner",
    ],
    { env: { PATH: process.env.PATH, HOME: home, ...extraEnv } },
  );
  let text = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start:\n${text}`)), 45_000);
    child.stdout.on("data", (b: Buffer) => {
      text += b.toString();
      if (text.includes("API:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", () => reject(new Error(`serve exited early:\n${text}`)));
  });
  child.removeAllListeners("exit");
  child.kill("SIGTERM");
  return text;
}

it("under systemd (JOURNAL_STREAM) serve mints no link and prints the open command", async () => {
  const data = await mkdtemp(join(tmpdir(), "boof-journal-"));
  const home = await mkdtemp(join(tmpdir(), "boof-journal-home-"));
  dirs.push(data, home);
  const text = await serveOutput({ JOURNAL_STREAM: "8:12345" }, data, home);
  expect(text).not.toContain("bl_");
  expect(text).toMatch(/Sign in to the web UI: boof-runner open -d ".+" --port \d+/);
  expect(text).toContain(`-d "${data}"`);
  expect(await readdir(data).catch(() => [])).not.toContain("auth");
}, 60_000);

it("without JOURNAL_STREAM serve still prints a sign-in link", async () => {
  const data = await mkdtemp(join(tmpdir(), "boof-journal-"));
  const home = await mkdtemp(join(tmpdir(), "boof-journal-home-"));
  dirs.push(data, home);
  const text = await serveOutput({}, data, home);
  expect(text).toMatch(/Web UI: {2}http:\/\/127\.0\.0\.1:\d+\/auth\/browser\?code=bl_/);
}, 60_000);
