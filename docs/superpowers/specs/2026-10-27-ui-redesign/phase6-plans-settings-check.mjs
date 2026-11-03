// Browser checks of the Plans and Settings simple and expanded views (UI phase 6). The project
// needs a draft plan and an archived plan.
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:4477/ OUT=/tmp/shots node phase6-plans-settings-check.mjs
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
const toggleOf = (p) => p.getByRole("button", { name: /^Show (expanded|simple) view$/ });
const visible = async (p, text) =>
  p
    .getByText(text, { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
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
    // Plans
    let tag = `plans ${w}px ${scheme}`;
    await p.goto(`${BASE}p/${PID}/plans`);
    await toggleOf(p).waitFor();
    await p.waitForTimeout(1800);
    check(
      await visible(p, "A draft plan waiting for the owner with a long title to wrap on the inbox"),
      `${tag} simple: draft plan visible`,
    );
    check(!(await visible(p, "An old plan")), `${tag} simple: archived plan collapsed`);
    if (w === 420) check(!(await sideways(p)), `${tag} simple: no sideways scroll`);
    await p.screenshot({ path: `${OUT}/phase6-plans-simple-${w}-${scheme}.png` });
    await toggleOf(p).click();
    await p.waitForTimeout(300);
    check(await visible(p, "An old plan"), `${tag} expanded: archived plan shown`);
    check(
      await visible(p, "A draft plan waiting for the owner with a long title to wrap on the inbox"),
      `${tag} expanded: draft plan visible`,
    );
    if (w === 420) check(!(await sideways(p)), `${tag} expanded: no sideways scroll`);
    await p.screenshot({ path: `${OUT}/phase6-plans-expanded-${w}-${scheme}.png` });
    await toggleOf(p).click(); // leave simple for the next run
    // Settings > Agents
    tag = `settings agents ${w}px ${scheme}`;
    await p.goto(`${BASE}p/${PID}/settings/agents`);
    await toggleOf(p).waitFor();
    await p.waitForTimeout(1800);
    check(await visible(p, "Roles"), `${tag} simple: Roles visible`);
    check(
      !(await p
        .getByLabel("Only a reviewer approval finishes a task as done")
        .first()
        .isVisible()
        .catch(() => false)),
      `${tag} simple: Review fields hidden`,
    );
    const show = p.getByRole("button", { name: "Show Review" });
    check(
      (await show.getAttribute("aria-expanded")) === "false",
      `${tag} simple: disclosure collapsed`,
    );
    if (w === 420) check(!(await sideways(p)), `${tag} simple: no sideways scroll`);
    await p.screenshot({ path: `${OUT}/phase6-settings-simple-${w}-${scheme}.png` });
    await show.click();
    check(
      (await p.getByRole("button", { name: "Hide Review" }).getAttribute("aria-expanded")) ===
        "true",
      `${tag}: disclosure opens`,
    );
    await p.getByRole("button", { name: "Hide Review" }).click();
    await toggleOf(p).click();
    await p.waitForTimeout(300);
    check(
      (await p.getByRole("button", { name: /^(Show|Hide) Review$/ }).count()) === 0,
      `${tag} expanded: no disclosure, all sections open`,
    );
    if (w === 420) check(!(await sideways(p)), `${tag} expanded: no sideways scroll`);
    await p.screenshot({ path: `${OUT}/phase6-settings-expanded-${w}-${scheme}.png` });
    await toggleOf(p).click();
    // an unsaved edit in simple keeps advanced sections open and the Save bar visible
    await show.click(); // open Review, edit nothing: instead edit a main field
    await p.getByRole("button", { name: "Hide Review" }).click();
    const first = p.locator("input[type=number], input:not([type])").first();
    await first.fill("7");
    const save = p.getByRole("button", { name: /^Save/ });
    check(await save.first().isVisible(), `${tag}: Save bar visible with an unsaved edit`);
    check(
      (await p.getByRole("button", { name: /^(Show|Hide) Review$/ }).count()) === 0,
      `${tag}: unsaved edit opens the advanced sections`,
    );
    await ctx.close();
  }
}
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
