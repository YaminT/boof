// Browser checks of the simple/expanded views (UI phase 6). Needs a running server whose project
// has a draft plan, queued and draft tasks and one archived task, and Playwright:
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:4477/ OUT=/tmp/shots node phase6-check.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:4477/";
const OUT = process.env.OUT ?? ".";
const PID = process.env.PID ?? "repo";
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};
const sideways = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
const toggleOf = (p) => p.getByRole("button", { name: /^Expanded view$/ });
const has = async (p, text) => (await p.getByText(text, { exact: false }).count()) > 0;

const screens = [
  {
    name: "overview",
    path: `p/${PID}`,
    simple: { yes: ["Now"], no: ["Recent", "Spend today"] },
    expanded: { yes: ["Now", "Recent"] },
  },
  {
    name: "tasks",
    path: `p/${PID}/tasks`,
    simple: { yes: ["Needs you", "Queued", "Drafts", "Failed task"], no: [] },
    expanded: { yes: ["Needs you", "Queued", "Drafts", "Finished"] },
  },
  {
    name: "inbox",
    path: "inbox",
    simple: { yes: ["Inbox", "Draft plan"] },
    expanded: { yes: ["Inbox", "Draft plan"] },
  },
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
      for (const mode of ["simple", "expanded"]) {
        if (mode === "expanded") {
          await toggleOf(p).click();
          await p.waitForTimeout(400);
        } else {
          await p.goto(BASE + s.path);
          await toggleOf(p).waitFor();
          await p.waitForTimeout(2000);
        }
        const tag = `${s.name} ${w}px ${scheme} ${mode}`;
        for (const t of s[mode].yes ?? []) check(await has(p, t), `${tag}: shows ${t}`);
        for (const t of s[mode].no ?? []) check(!(await has(p, t)), `${tag}: hides ${t}`);
        check(
          (await p.getByRole("textbox", { name: "Command" }).count()) === 1,
          `${tag}: console still there`,
        );
        if (w === 420) check(!(await sideways(p)), `${tag}: no sideways scroll`);
        await p.screenshot({ path: `${OUT}/phase6-${s.name}-${mode}-${w}-${scheme}.png` });
      }
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
