// Browser check of the focus toggle (UI phase 6). Needs a running server and Playwright:
//   PLAYWRIGHT=/path/to/playwright/index.mjs BASE=http://127.0.0.1:4477/ PAGE=p/repo/tasks node phase6-focus-toggle-check.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:4477/";
const PAGE = process.env.PAGE ?? "p/repo/tasks";
const OUT = process.env.OUT;
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};
const linearColor = (color) => {
  const values = color.match(/[\d.-]+/g).map(Number);
  if (color.startsWith("oklab(")) {
    const [L, a, b] = values;
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const linear = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return {
      channels: linear.map((v) => {
        const c = Math.max(0, v);
        return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
      }),
      alpha: values[3] ?? 1,
    };
  }
  const channels = values.slice(0, 3).map((v) => v / 255);
  return { channels, alpha: values[3] ?? 1 };
};
const luminance = (color, backdrop) => {
  const { channels, alpha } = linearColor(color);
  const behind = backdrop ? linearColor(backdrop).channels : [0, 0, 0];
  const composited = channels.map((v, i) => {
    const c = v * alpha + behind[i] * (1 - alpha);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return composited[0] * 0.2126 + composited[1] * 0.7152 + composited[2] * 0.0722;
};
const contrast = (foreground, background, backdrop) => {
  const a = luminance(foreground, backdrop);
  const b = luminance(background, backdrop);
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
  await toggle.hover();
  await p.waitForTimeout(250);
  const offHoverStyle = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      foreground: s.color,
      backdrop: getComputedStyle(document.body).backgroundColor,
    };
  });
  const offHoverContrast = contrast(
    offHoverStyle.foreground,
    offHoverStyle.background,
    offHoverStyle.backdrop,
  );
  console.log(`${tag}: unpressed + hover text contrast ${offHoverContrast.toFixed(2)}:1`);
  check(offHoverContrast >= 4.5, `${tag}: unpressed + hover text contrast >= 4.5:1`);
  if (OUT && !denyStorage)
    await p.screenshot({ path: `${OUT}/focus-toggle-off-hover-${scheme}.png` });
  await p.mouse.move(0, 0);
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
  await toggle.hover();
  await p.waitForTimeout(250);
  const onHoverStyle = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      foreground: s.color,
      backdrop: getComputedStyle(document.body).backgroundColor,
    };
  });
  const onHoverContrast = contrast(
    onHoverStyle.foreground,
    onHoverStyle.background,
    onHoverStyle.backdrop,
  );
  console.log(`${tag}: pressed + hover text contrast ${onHoverContrast.toFixed(2)}:1`);
  check(onHoverContrast >= 4.5, `${tag}: pressed + hover text contrast >= 4.5:1`);
  if (OUT && !denyStorage)
    await p.screenshot({ path: `${OUT}/focus-toggle-on-hover-${scheme}.png` });
  await p.mouse.move(0, 0);
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
