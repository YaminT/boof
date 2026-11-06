// Visual and layout check of Console A and the hierarchy screens (roadmap step 11).
// Needs a running server with a project "repo" that has epics and tasks, and Playwright:
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:4477/ OUT=/tmp/shots node step11-check.mjs
// Writes <screen>-<1440|420>-<light|dark>.png and exits 1 when a check fails: sideways scroll at
// 420 px, a console input that is not visible and reachable, or a Manage epics sheet that cannot
// be opened and closed.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:4477/";
const OUT = process.env.OUT ?? ".";
const PID = process.env.PID ?? "repo";
const PARENT = process.env.PARENT;
const SUBTASK = process.env.SUBTASK;
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};

const sideways = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
const consoleReachable = (p) =>
  p.evaluate(() => {
    const el = document.querySelector('input[aria-label="Command"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth)
      return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el;
  });

const screens = [
  { name: "inbox", path: "inbox" },
  { name: "tasks", path: `p/${PID}/tasks` },
  { name: "tasks-grouped", path: `p/${PID}/tasks`, grouped: true },
  { name: "task-parent", path: `p/${PID}/tasks/${PARENT}` },
  { name: "task-subtask", path: `p/${PID}/tasks/${SUBTASK}` },
  { name: "manage-epics", path: `p/${PID}/tasks`, manage: true },
  { name: "console-output", path: `p/${PID}/tasks`, output: true },
];

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const [w, h] of [
    [1440, 1000],
    [420, 900],
  ]) {
    for (const s of screens) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: scheme,
      });
      const p = await ctx.newPage();
      if (s.grouped)
        await p.addInitScript((pid) => localStorage.setItem(`boof.groupByEpic.${pid}`, "1"), PID);
      await p.goto(BASE + s.path);
      await p.getByRole("textbox", { name: "Command" }).waitFor();
      await p.waitForTimeout(2500);
      const tag = `${s.name} ${w}px ${scheme}`;
      if (s.manage) {
        await p.getByRole("button", { name: "Manage epics…" }).scrollIntoViewIfNeeded();
        await p.getByRole("button", { name: "Manage epics…" }).click();
        await p.getByRole("heading", { name: "Manage epics" }).waitFor();
        await p.waitForTimeout(500);
        const close = await p.getByRole("button", { name: "Close" }).boundingBox();
        check(
          !!close && close.x >= 0 && close.x + close.width <= w && close.y >= 0,
          `${tag}: sheet can be closed`,
        );
      }
      if (s.output) {
        const input = p.getByRole("textbox", { name: "Command" });
        for (const c of ["/nope", "/go plans", "/go tasks"]) {
          await input.fill(c);
          await input.press("Enter");
          await p.waitForTimeout(500);
        }
      }
      if (!s.manage)
        check(await consoleReachable(p), `${tag}: console input visible and reachable`);
      if (w === 420) check(!(await sideways(p)), `${tag}: no sideways scroll`);
      await p.screenshot({ path: `${OUT}/${s.name}-${w}-${scheme}.png` });
      await ctx.close();
    }
  }
}
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
