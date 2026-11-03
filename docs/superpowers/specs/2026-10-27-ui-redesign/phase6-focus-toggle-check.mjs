// Browser check of the focus toggle (UI phase 6). Needs a running server and Playwright:
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:4477/ PAGE=p/repo/tasks node phase6-focus-toggle-check.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:4477/";
const PAGE = process.env.PAGE ?? "p/repo/tasks";
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};
const browser = await chromium.launch();

async function run(denyStorage) {
  const tag = denyStorage ? "storage denied" : "storage works";
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  if (denyStorage)
    await p.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("denied");
        },
      });
    });
  await p.goto(BASE + PAGE);
  const toggle = p.getByRole("button", { name: /^Show (expanded|simple) view$/ });
  await toggle.waitFor();
  check((await toggle.innerText()) === "Simple", `${tag}: starts simple`);
  check((await toggle.getAttribute("aria-pressed")) === "false", `${tag}: aria-pressed false`);
  check(
    (await toggle.getAttribute("aria-label")) === "Show expanded view",
    `${tag}: names the action`,
  );
  await toggle.focus();
  const ring = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return s.boxShadow !== "none" || s.outlineStyle !== "none";
  });
  check(ring, `${tag}: visible focus indicator`);
  await p.keyboard.press("Enter");
  check((await toggle.innerText()) === "Expanded", `${tag}: Enter expands at once`);
  check((await toggle.getAttribute("aria-pressed")) === "true", `${tag}: aria-pressed true`);
  await p.keyboard.press("Space");
  check((await toggle.innerText()) === "Simple", `${tag}: Space collapses`);
  await p.keyboard.press("Space");
  await p.reload();
  await toggle.waitFor();
  const after = await toggle.innerText();
  check(after === (denyStorage ? "Simple" : "Expanded"), `${tag}: after reload shows ${after}`);
  await ctx.close();
}
await run(false);
await run(true);
await browser.close();
if (failures.length) process.exit(1);
console.log("\nall checks passed");
