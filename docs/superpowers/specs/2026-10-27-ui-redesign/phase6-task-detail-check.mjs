// Browser checks of the task page's simple and expanded views (UI phase 6).
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:4477/ OUT=/tmp/shots TASK=fix-login node phase6-task-detail-check.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:4477/";
const OUT = process.env.OUT ?? ".";
const PATH = `p/${process.env.PID ?? "repo"}/tasks/${process.env.TASK ?? "fix-login"}`;
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};
const sideways = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
const toggleOf = (p) => p.getByRole("button", { name: /^Expanded view$/ });
const title = (p) => p.getByLabel("Title", { exact: true });
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const [w, h] of [
    [1440, 1000],
    [420, 900],
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      colorScheme: scheme,
    });
    const p = await ctx.newPage();
    const tag = `task ${w}px ${scheme}`;
    await p.goto(BASE + PATH);
    await toggleOf(p).waitFor();
    await p.waitForTimeout(2000);
    // simple: form tucked away, the rest stays
    check(!(await title(p).isVisible()), `${tag} simple: form hidden`);
    check(
      (await p.getByRole("heading", { level: 1 }).count()) === 1,
      `${tag} simple: header stays`,
    );
    check(
      (await p.getByRole("navigation", { name: "Task view" }).count()) === 1,
      `${tag} simple: Run/Changes/Questions stay`,
    );
    check(
      (await p.getByRole("textbox", { name: "Command" }).count()) === 1,
      `${tag} simple: console stays`,
    );
    const disclose = p.getByRole("button", { name: "Edit task details" });
    check(
      (await disclose.getAttribute("aria-expanded")) === "false",
      `${tag} simple: disclosure collapsed`,
    );
    if (w === 420) check(!(await sideways(p)), `${tag} simple: no sideways scroll`);
    await p.screenshot({ path: `${OUT}/phase6-task-simple-${w}-${scheme}.png` });
    // open it, edit, then the form must not be hideable
    await disclose.click();
    check(await title(p).isVisible(), `${tag}: disclosure opens the form`);
    await title(p).fill((await title(p).inputValue()) + " x");
    const hide = p.getByRole("button", { name: "Hide task details" });
    check(
      (await hide.getAttribute("aria-disabled")) === "true" &&
        (await p.getByText("Task details stay open while they have unsaved changes.").isVisible()),
      `${tag}: unsaved edit keeps details open with a visible reason`,
    );
    await toggleOf(p).click();
    check(await title(p).isVisible(), `${tag} expanded: form shown with edits kept`);
    check((await title(p).inputValue()).endsWith(" x"), `${tag} expanded: edit kept`);
    if (w === 420) check(!(await sideways(p)), `${tag} expanded: no sideways scroll`);
    await p.screenshot({ path: `${OUT}/phase6-task-expanded-${w}-${scheme}.png` });
    // back to simple with an unsaved edit: still open
    await toggleOf(p).click();
    check(await title(p).isVisible(), `${tag} simple again: dirty form still open`);
    // questions view stays reachable
    await p.getByRole("link", { name: "Questions" }).click();
    await p.waitForTimeout(500);
    check(p.url().endsWith("/questions"), `${tag}: Questions view reachable`);
    await ctx.close();
  }
}
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
