// Renders the Changes view with a mocked diff (the task has no real branch) at both widths and
// schemes, checks no page-level sideways scroll and no sub-4.5 text in dark. Usage: node phase6-changes-diff-check.mjs <outdir>
import { chromium } from "playwright";
const out = process.argv[2];
const long = "x".repeat(260);
const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,6 @@
 import x from "x";
-const old = 1;
+const fresh = 2;
+const alsoNew = "${long}";
 export const y = 3;
 // end
`;
const diff = {
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "boof/fix-login", sha: "b".repeat(40) },
  files: [
    { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
    { path: "src/new-file.ts", status: "added", additions: 10, deletions: 0 },
    { path: "old.ts", status: "deleted", additions: 0, deletions: 4 },
    { path: "img.png", status: "binary", additions: 0, deletions: 0 },
  ],
  stats: { files: 4, additions: 12, deletions: 5 },
  patch,
  truncated: false,
  commits: [
    {
      sha: "c".repeat(40),
      subject: "Fix the login flow so it does not redirect twice and so on",
      author: "Dev",
      date: "2026-11-02T10:00:00Z",
    },
  ],
  includesUncommitted: true,
};
const b = await chromium.launch();
for (const scheme of ["light", "dark"])
  for (const [w, h] of [
    [1440, 1000],
    [420, 900],
  ]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    const p = await ctx.newPage();
    await p.route(
      (u) => u.pathname.endsWith("/diff"),
      (r) => r.fulfill({ json: diff }),
    );
    await p.route(
      (u) => u.pathname.endsWith("/tasks/fix-login"),
      async (r) => {
        const res = await r.fetch();
        const j = await res.json();
        j.branch = "boof/fix-login";
        await r.fulfill({ response: res, json: j });
      },
    );
    await p.goto("http://127.0.0.1:4477/p/repo/tasks/fix-login/changes");
    await p.waitForTimeout(2500);
    console.log(
      w,
      scheme,
      "overflowX:",
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      "diff region scrolls:",
      await p.evaluate(() => {
        const r = document.querySelector('[aria-label^="Diff of"]');
        return r ? r.scrollWidth > r.clientWidth : null;
      }),
    );
    await p.screenshot({ path: `${out}/changes-diff-${w}-${scheme}.png` });
    if (scheme === "dark" && w === 1440) {
      const low = await p.evaluate(() => {
        const lum = (c) => {
          const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const parse = (s) => {
          const m = s.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const a = m[1]
            .split(/[ ,\/]+/)
            .filter(Boolean)
            .map(Number);
          return { c: a.slice(0, 3), a: a[3] ?? 1 };
        };
        const bgOf = (el) => {
          let l = [];
          for (let e = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor);
            if (c && c.a > 0) {
              l.push(c);
              if (c.a >= 1) break;
            }
          }
          let base = [15, 20, 24];
          for (let i = l.length - 1; i >= 0; i--)
            base = base.map((v, k) => l[i].c[k] * l[i].a + v * (1 - l[i].a));
          return base;
        };
        const res = [];
        for (const el of document.querySelectorAll(
          '[aria-label^="Diff of"] *, [aria-label="Changed files"] *',
        )) {
          const own = [...el.childNodes]
            .filter((n) => n.nodeType === 3 && n.textContent.trim())
            .map((n) => n.textContent.trim())
            .join(" ");
          if (!own) continue;
          const st = getComputedStyle(el);
          const fg = parse(st.color);
          const bg = bgOf(el);
          const f = fg.c.map((v, k) => v * fg.a + bg[k] * (1 - fg.a));
          const r = (Math.max(lum(f), lum(bg)) + 0.05) / (Math.min(lum(f), lum(bg)) + 0.05);
          if (r < 4.5) res.push(r.toFixed(2) + " " + own.slice(0, 25));
        }
        return res;
      });
      console.log("dark diff low contrast:", JSON.stringify(low));
    }
    await ctx.close();
  }
await b.close();
