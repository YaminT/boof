import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_LINK_TTL_MS,
  BROWSER_SESSION_IDLE_MS,
  BROWSER_SESSION_MAX_MS,
  BrowserSessionStore,
} from "./browser-session-store.js";
import { browserSessionCookieName } from "./index.js";
import { dataRootPaths } from "./paths.js";
import { withProcessLock } from "./process-lock.js";

const DAY_MS = 86_400_000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function simulatedProcess(pid: number) {
  return { lock: { pid, bootId: null, isProcessAlive: () => true, lockPollMs: 1 } };
}

describe("BrowserSessionStore", () => {
  let root: string;
  let clock: number;
  let store: BrowserSessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "boof-runner-browser-session-"));
    clock = Date.parse("2026-01-01T00:00:00.000Z");
    store = new BrowserSessionStore(root, () => clock);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("a redeemed link yields a token that verify accepts", async () => {
    const link = await store.createLink();
    expect(link.code).toMatch(/^bl_[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt).toBe(new Date(clock + BROWSER_LINK_TTL_MS).toISOString());

    const redeemed = await store.redeemLink(link.code);
    expect(redeemed).not.toBeNull();
    expect(redeemed!.token).toMatch(/^bs_[A-Za-z0-9_-]{43}$/);
    expect(redeemed!.session.createdAt).toBe(new Date(clock).toISOString());
    expect(redeemed!.session.lastUsedAt).toBe(redeemed!.session.createdAt);
    expect(redeemed!.session.expiresAt).toBe(
      new Date(clock + BROWSER_SESSION_IDLE_MS).toISOString(),
    );

    expect((await store.verify(redeemed!.token))?.id).toBe(redeemed!.session.id);
  });

  it("a link redeems once", async () => {
    const { code } = await store.createLink();
    const first = await store.redeemLink(code);
    expect(first).not.toBeNull();
    expect(await store.redeemLink(code)).toBeNull();
    expect((await store.verify(first!.token))?.id).toBe(first!.session.id);

    const sessions = JSON.parse(await readFile(dataRootPaths(root).browserSessions, "utf8"));
    expect(sessions.sessions).toHaveLength(1);
  });

  it("two concurrent redeems of one link: exactly one succeeds", async () => {
    const { code } = await store.createLink();
    const results = await Promise.all([store.redeemLink(code), store.redeemLink(code)]);
    const won = results.filter((result) => result !== null);
    expect(won).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect((await store.verify(won[0]!.token))?.id).toBe(won[0]!.session.id);

    const sessions = JSON.parse(await readFile(dataRootPaths(root).browserSessions, "utf8"));
    expect(sessions.sessions).toHaveLength(1);
  });

  it("a link redeems once across processes", async () => {
    const { code } = await store.createLink();
    const processA = new BrowserSessionStore(root, () => clock, simulatedProcess(81001));
    const processB = new BrowserSessionStore(root, () => clock, simulatedProcess(81002));

    const results = await Promise.all([processA.redeemLink(code), processB.redeemLink(code)]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("a link redeems once between real Node processes", async () => {
    const { code } = await store.createLink();
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "packages/heart/src/browser-session-store.ts"),
    );
    const childPath = join(root, "redeem-child.mjs");
    const readyPath = join(root, "child-ready");
    const releasePath = join(root, "child-release");
    await writeFile(
      childPath,
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `import { BrowserSessionStore } from ${JSON.stringify(moduleUrl.href)};\n` +
        `const [root, code, now, ready, release] = process.argv.slice(2);\n` +
        `const waitForRelease = () => { writeFileSync(ready, "ready"); ` +
        `while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); ` +
        `return Number(now); };\n` +
        `const result = await new BrowserSessionStore(root, waitForRelease).redeemLink(code);\n` +
        `process.stdout.write(result ? "won" : "lost");\n`,
    );

    const childResult = new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", childPath, root, code, String(clock), readyPath, releasePath],
        {
          cwd: process.cwd(),
          env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: tmpdir(), TZ: "UTC" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`redeem child exited ${code}: ${stderr}`));
      });
    });
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline) {
      try {
        await access(readyPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    await expect(access(readyPath)).resolves.toBeUndefined();
    const parentResult = store.redeemLink(code);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(releasePath, "release");
    const [childWon, parentWon] = await Promise.all([childResult, parentResult]);
    expect([childWon === "won", parentWon !== null].filter(Boolean)).toHaveLength(1);
    expect([childWon === "lost", parentWon === null].filter(Boolean)).toHaveLength(1);
  });

  it("a createLink in another process does not resurrect a redeemed link", async () => {
    const { code } = await store.createLink();
    const processA = new BrowserSessionStore(root, () => clock, simulatedProcess(82001));
    const processB = new BrowserSessionStore(root, () => clock, simulatedProcess(82002));

    const [redeemed] = await Promise.all([processA.redeemLink(code), processB.createLink()]);
    expect(redeemed).not.toBeNull();
    expect(await store.redeemLink(code)).toBeNull();
  });

  it("a link expires after 10 minutes", async () => {
    const live = await store.createLink();
    clock += BROWSER_LINK_TTL_MS - 1;
    expect(await store.redeemLink(live.code)).not.toBeNull();

    const expired = await store.createLink();
    clock += BROWSER_LINK_TTL_MS;
    expect(await store.redeemLink(expired.code)).toBeNull();
  });

  it("verify refuses undefined, '', 'bs_x', a code, and an unknown bs_ token", async () => {
    const { code } = await store.createLink();
    const { token } = await store.createSession();
    expect(await store.verify(undefined)).toBeNull();
    expect(await store.verify("")).toBeNull();
    expect(await store.verify("bs_x")).toBeNull();
    expect(await store.verify(code)).toBeNull();
    expect(await store.verify(`bs_${"a".repeat(43)}`)).toBeNull();
    expect((await store.verify(token))?.id).toBeTruthy();
    // A refused code is still unused.
    expect(await store.redeemLink(code)).not.toBeNull();
  });

  it("idle expiry: unused for 7 days is refused; use on day 6 slides it", async () => {
    const start = clock;
    const unused = await store.createSession();
    clock = start + BROWSER_SESSION_IDLE_MS;
    expect(await store.verify(unused.token)).toBeNull();

    clock = start;
    const slid = await store.createSession();
    clock = start + 6 * DAY_MS;
    expect((await store.verify(slid.token))?.id).toBe(slid.session.id);
    // A second instance reads the file. The slide has to be on disk, not only in memory.
    const other = new BrowserSessionStore(root, () => clock);
    clock = start + BROWSER_SESSION_IDLE_MS;
    expect((await other.verify(slid.token))?.id).toBe(slid.session.id);

    clock = start;
    const bounded = await store.createSession();
    clock = start + 6 * DAY_MS;
    expect((await store.verify(bounded.token))?.id).toBe(bounded.session.id);
    const reader = new BrowserSessionStore(root, () => clock);
    clock = start + 6 * DAY_MS + BROWSER_SESSION_IDLE_MS;
    expect(await reader.verify(bounded.token)).toBeNull();
  });

  it("absolute expiry: refused after 30 days even when used daily", async () => {
    const start = clock;
    const { token, session } = await store.createSession();
    for (let day = 1; day <= 29; day += 1) {
      clock = start + day * DAY_MS;
      expect((await store.verify(token))?.id, `day ${day}`).toBe(session.id);
    }
    clock = start + BROWSER_SESSION_MAX_MS - 1;
    expect((await store.verify(token))?.id).toBe(session.id);
    clock = start + BROWSER_SESSION_MAX_MS;
    expect(await store.verify(token)).toBeNull();
  });

  it("a link created by one instance redeems in another at once", async () => {
    const other = new BrowserSessionStore(root, () => clock);
    expect(await other.redeemLink("bl_not-a-real-link")).toBeNull();

    const { code } = await store.createLink();
    const redeemed = await other.redeemLink(code);
    expect(redeemed).not.toBeNull();
    expect((await store.verify(redeemed!.token))?.id).toBe(redeemed!.session.id);
  });

  it("revokeAll ends sessions for a second instance on the same root", async () => {
    const other = new BrowserSessionStore(root, () => clock);
    const first = await store.createSession();
    const second = await store.createSession();
    expect((await other.verify(first.token))?.id).toBe(first.session.id);

    expect(await store.revokeAll()).toBe(2);
    expect(await other.verify(first.token)).toBeNull();
    expect(await other.verify(second.token)).toBeNull();
    expect(await store.verify(first.token)).toBeNull();
  });

  it("revokeAll clears pending sign-in links", async () => {
    const { code } = await store.createLink();
    expect(await store.revokeAll()).toBe(0);
    expect(await store.redeemLink(code)).toBeNull();
  });

  it("revokeAll counts only live sessions", async () => {
    await store.createSession();
    clock += BROWSER_SESSION_IDLE_MS;
    expect(await store.revokeAll()).toBe(0);
  });

  it("verify reloads same-size rewrites with a forced identical mtime", async () => {
    const first = await store.createSession();
    expect((await store.verify(first.token))?.id).toBe(first.session.id);
    const path = dataRootPaths(root).browserSessions;
    const before = await stat(path);
    const other = new BrowserSessionStore(root, () => clock);
    expect(await other.revokeAll()).toBe(1);
    const second = await other.createSession();
    expect((await stat(path)).size).toBe(before.size);
    await utimes(path, before.atime, before.mtime);

    expect(await store.verify(first.token)).toBeNull();
    expect((await store.verify(second.token))?.id).toBe(second.session.id);
  });

  it("revokeAll racing a lastUsedAt write leaves no session", async () => {
    const created = await store.createSession();
    expect(await store.verify(created.token)).not.toBeNull();
    clock += 60_001;
    const processA = new BrowserSessionStore(root, () => clock, simulatedProcess(83001));
    const processB = new BrowserSessionStore(root, () => clock, simulatedProcess(83002));
    await processA.verify(created.token); // Prime this process's lock-free read cache.

    await Promise.all([processA.verify(created.token), processB.revokeAll()]);
    expect(await processA.verify(created.token)).toBeNull();
    expect(await store.verify(created.token)).toBeNull();
    const sessions = JSON.parse(await readFile(dataRootPaths(root).browserSessions, "utf8"));
    expect(sessions.sessions).toHaveLength(0);
  });

  it("mutations wait for the cross-process browser session lock", async () => {
    const lockPath = join(dataRootPaths(root).auth, ".browser-session.lock");
    let acquired!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (acquired = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = withProcessLock(
      lockPath,
      { pid: 84001, bootId: null, isProcessAlive: () => true },
      async () => {
        acquired();
        await gate;
      },
      (pid) => new Error(`holder ${pid}`),
    );
    await held;
    try {
      const blocked = new BrowserSessionStore(root, () => clock, {
        lock: { lockTimeoutMs: 20, lockPollMs: 1, isProcessAlive: () => true },
      });
      await expect(blocked.createLink()).rejects.toThrow(/Another boof process.*pid 84001/);
    } finally {
      release();
      await holder;
    }
  });

  it("files hold only hashes", async () => {
    const link = await store.createLink();
    const created = await store.createSession();
    const paths = dataRootPaths(root);
    expect(paths.browserLinks).toBe(join(root, "auth", "browser-links.json"));
    expect(paths.browserSessions).toBe(join(root, "auth", "browser-sessions.json"));

    const names = await readdir(paths.auth);
    const texts = await Promise.all(
      names.map(async (name) => readFile(join(paths.auth, name), "utf8")),
    );
    const combined = texts.join("\n");
    expect(combined).not.toContain(link.code);
    expect(combined).not.toContain(created.token);
    expect(combined).toContain(sha256Hex(link.code));
    expect(combined).toContain(sha256Hex(created.token));

    const redeemed = await store.redeemLink(link.code);
    expect(redeemed).not.toBeNull();
    const after = (
      await Promise.all(
        (await readdir(paths.auth)).map(async (name) => readFile(join(paths.auth, name), "utf8")),
      )
    ).join("\n");
    expect(after).not.toContain(link.code);
    expect(after).not.toContain(redeemed!.token);
    expect(after).not.toContain(sha256Hex(link.code));
    expect(after).toContain(sha256Hex(redeemed!.token));
  });

  it.skipIf(process.platform === "win32")("modes: auth dir 0700, both files 0600", async () => {
    await store.createLink();
    await store.createSession();
    const paths = dataRootPaths(root);
    expect((await stat(paths.auth)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.browserLinks)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.browserSessions)).mode & 0o777).toBe(0o600);
  });

  it("caps: 21st link drops the oldest; 51st session drops the oldest", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 21; i += 1) codes.push((await store.createLink()).code);
    const links = JSON.parse(await readFile(dataRootPaths(root).browserLinks, "utf8"));
    expect(links.links).toHaveLength(20);
    expect(links.links[0].hash).toBe(sha256Hex(codes[1]));
    expect(links.links.map((link: { hash: string }) => link.hash)).not.toContain(
      sha256Hex(codes[0]),
    );
    expect(links.links.at(-1).hash).toBe(sha256Hex(codes[20]));
    expect(await store.redeemLink(codes[0])).toBeNull();

    const tokens: string[] = [];
    for (let i = 0; i < 51; i += 1) tokens.push((await store.createSession()).token);
    const sessions = JSON.parse(await readFile(dataRootPaths(root).browserSessions, "utf8"));
    expect(sessions.sessions).toHaveLength(50);
    expect(sessions.sessions[0].hash).toBe(sha256Hex(tokens[1]));
    expect(sessions.sessions.map((row: { hash: string }) => row.hash)).not.toContain(
      sha256Hex(tokens[0]),
    );
    expect(sessions.sessions.at(-1).hash).toBe(sha256Hex(tokens[50]));
    expect(await store.verify(tokens[0])).toBeNull();
    expect(await store.verify(tokens[1])).not.toBeNull();
    expect(await store.verify(tokens[50])).not.toBeNull();
  });

  it("verify writes lastUsedAt at most once per 60 seconds", async () => {
    const start = clock;
    const { token } = await store.createSession();
    const path = dataRootPaths(root).browserSessions;
    const lastUsedAt = async () => {
      const body = JSON.parse(await readFile(path, "utf8")) as {
        sessions: { lastUsedAt: string }[];
      };
      return body.sessions[0]?.lastUsedAt;
    };

    clock += 30_000;
    expect(await store.verify(token)).not.toBeNull();
    expect(await lastUsedAt()).toBe(new Date(start).toISOString());

    clock += 30_001;
    expect((await store.verify(token))?.lastUsedAt).toBe(new Date(clock).toISOString());
    expect(await lastUsedAt()).toBe(new Date(clock).toISOString());

    expect(await store.verify(token)).not.toBeNull();
    expect(await lastUsedAt()).toBe(new Date(clock).toISOString());
  });

  it("a corrupt sessions file is no sessions and logs once", async () => {
    const { token } = await store.createSession();
    const path = dataRootPaths(root).browserSessions;
    await writeFile(path, "{not json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await store.verify(token)).toBeNull();
      expect(await store.verify(token)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain(path);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain("not json");
    } finally {
      spy.mockRestore();
    }

    await writeFile(path, '{ "sessions": [] }\n');
    const again = await store.createSession();
    expect((await store.verify(again.token))?.id).toBe(again.session.id);
  });

  it("revokeAll resets corrupt links and sessions files to empty lists", async () => {
    const paths = dataRootPaths(root);
    await store.createLink();
    await store.createSession();
    await writeFile(paths.browserLinks, "link-body-must-not-be-logged");
    await writeFile(paths.browserSessions, "session-body-must-not-be-logged");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await store.revokeAll()).toBe(0);
      const logged = spy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain(paths.browserLinks);
      expect(logged).toContain(paths.browserSessions);
      expect(logged).not.toContain("link-body-must-not-be-logged");
      expect(logged).not.toContain("session-body-must-not-be-logged");
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(await readFile(paths.browserLinks, "utf8"))).toEqual({ links: [] });
    expect(JSON.parse(await readFile(paths.browserSessions, "utf8"))).toEqual({ sessions: [] });
  });

  it("future-dated session records and links are expired beyond the clock-skew allowance", async () => {
    const { token } = await store.createSession();
    const paths = dataRootPaths(root);
    const sessionFile = JSON.parse(await readFile(paths.browserSessions, "utf8"));
    const future = new Date(clock + 60_001).toISOString();
    sessionFile.sessions[0].createdAt = future;
    sessionFile.sessions[0].lastUsedAt = future;
    await writeFile(paths.browserSessions, JSON.stringify(sessionFile));
    expect(await store.verify(token)).toBeNull();

    const link = await store.createLink();
    const linkFile = JSON.parse(await readFile(paths.browserLinks, "utf8"));
    linkFile.links[0].expiresAt = new Date(clock + BROWSER_LINK_TTL_MS + 60_001).toISOString();
    await writeFile(paths.browserLinks, JSON.stringify(linkFile));
    expect(await store.redeemLink(link.code)).toBeNull();
  });

  it("browserSessionCookieName(4319) is boof_ui_4319", () => {
    expect(browserSessionCookieName(4319)).toBe("boof_ui_4319");
    expect(browserSessionCookieName(80)).toBe("boof_ui_80");
  });
});
