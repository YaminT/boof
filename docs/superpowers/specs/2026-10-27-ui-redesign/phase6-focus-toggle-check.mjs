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
const luminance = (color) => {
  const channels = color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)
    .map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (foreground, background) => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const browser = await chromium.launch();

async function run(denyStorage, scheme) {
  const tag = `${denyStorage ? "storage denied" : "storage works"} ${scheme}`;
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: scheme,
  });
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
  const toggle = p.getByRole("button", { name: /^Expanded view$/ });
  await toggle.waitFor();
  check(
    (await toggle.innerText()).startsWith("Expanded view"),
    `${tag}: visible label is Expanded view`,
  );
  check((await toggle.getAttribute("aria-pressed")) === "false", `${tag}: aria-pressed false`);
  const offStyle = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, foreground: s.color, border: s.borderColor };
  });
  check(
    contrast(offStyle.foreground, offStyle.background) >= 4.5,
    `${tag}: off text contrast >= 4.5:1`,
  );
  check(
    (await toggle.getAttribute("aria-label")) === "Expanded view",
    `${tag}: has a constant accessible name`,
  );
  await toggle.focus();
  const ring = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return s.boxShadow !== "none" || s.outlineStyle !== "none";
  });
  check(ring, `${tag}: visible focus indicator`);
  await p.keyboard.press("Enter");
  check(
    (await toggle.innerText()).startsWith("Expanded view"),
    `${tag}: Enter keeps the constant visible label`,
  );
  check((await toggle.getAttribute("aria-pressed")) === "true", `${tag}: aria-pressed true`);
  const onStyle = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, foreground: s.color, border: s.borderColor };
  });
  check(
    onStyle.background !== offStyle.background ||
      onStyle.foreground !== offStyle.foreground ||
      onStyle.border !== offStyle.border,
    `${tag}: pressed and unpressed styles differ`,
  );
  check(
    contrast(onStyle.foreground, onStyle.background) >= 4.5,
    `${tag}: on text contrast >= 4.5:1`,
  );
  const indicator = toggle.locator("span[aria-hidden='true']");
  const indicatorContrast = await indicator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { foreground: s.color, background: getComputedStyle(el.parentElement).backgroundColor };
  });
  check(
    contrast(indicatorContrast.foreground, indicatorContrast.background) >= 3,
    `${tag}: pressed check indicator contrast >= 3:1`,
  );
  await p.keyboard.press("Space");
  check(
    (await toggle.innerText()).startsWith("Expanded view"),
    `${tag}: Space keeps the constant visible label`,
  );
  await p.keyboard.press("Space");
  await p.reload();
  await toggle.waitFor();
  const after = await toggle.innerText();
  check(after.startsWith("Expanded view"), `${tag}: label stays constant after reload`);
  check(
    (await toggle.getAttribute("aria-pressed")) === (denyStorage ? "false" : "true"),
    `${tag}: state persists after reload`,
  );
  await ctx.close();
}
for (const scheme of ["light", "dark"]) {
  await run(false, scheme);
  await run(true, scheme);
}
await browser.close();
if (failures.length) process.exit(1);
console.log("\nall checks passed");
