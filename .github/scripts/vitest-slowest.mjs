// Prints the slowest test files and tests from a Vitest JSON report, so a slow CI job can be read
// without rerunning it. Usage: node vitest-slowest.mjs <report.json> [count]
import { readFileSync } from "node:fs";

const [path, countArg] = process.argv.slice(2);
const count = Number(countArg) || 25;
if (!path) {
  console.error("usage: vitest-slowest.mjs <report.json> [count]");
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.log(`no test report at ${path}: ${error instanceof Error ? error.message : error}`);
  process.exit(0);
}

const root = `${process.cwd().replaceAll("\\", "/")}/`;
const files = [];
const tests = [];
for (const file of report.testResults ?? []) {
  const name = String(file.name).replaceAll("\\", "/").replace(root, "");
  const own = (file.assertionResults ?? []).reduce((sum, t) => sum + (t.duration ?? 0), 0);
  files.push({
    name,
    wall: file.endTime - file.startTime,
    own,
    count: file.assertionResults?.length ?? 0,
  });
  for (const t of file.assertionResults ?? [])
    tests.push({ name: `${name} > ${t.fullName ?? t.title}`, ms: t.duration ?? 0 });
}
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
console.log(
  `Slowest ${count} files by wall time (files run in parallel; sum of tests in brackets)`,
);
for (const f of files.sort((a, b) => b.wall - a.wall).slice(0, count))
  console.log(`${sec(f.wall).padStart(8)}  [${sec(f.own)}, ${f.count} tests]  ${f.name}`);
console.log(`\nSlowest ${count} tests`);
for (const t of tests.sort((a, b) => b.ms - a.ms).slice(0, count))
  console.log(`${sec(t.ms).padStart(8)}  ${t.name}`);
const total = files.reduce((sum, f) => sum + f.own, 0);
console.log(`\n${files.length} files, ${tests.length} tests, ${sec(total)} of test time in total`);
