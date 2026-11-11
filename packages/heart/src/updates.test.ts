import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataRootPaths, defaultSettings, SettingsStore } from "./index.js";
import { RELEASE_REPOSITORY } from "./version.js";
import {
  checkForUpdate,
  chooseRelease,
  cliNoticeLine,
  compareVersions,
  dismissUpdate,
  isPrerelease,
  parseReleases,
  readUpdateCache,
  releasesUrl,
  uiNotice,
  updateUserAgent,
  type UpdateCache,
  type UpdateFetch,
  type UpdateRequest,
} from "./updates.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-updates-"));
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const DAY = 24 * 60 * 60 * 1000;
const CURRENT = "0.4.0";

function release(
  tag: string,
  extra: { prerelease?: boolean; draft?: boolean; html_url?: string } = {},
) {
  return {
    tag_name: tag,
    html_url: extra.html_url ?? `https://github.com/YaminT/boof/releases/tag/${tag}`,
    prerelease: extra.prerelease ?? tag.includes("-"),
    draft: extra.draft ?? false,
  };
}

function recorder(
  status: number,
  body: string,
): { calls: UpdateRequest & { url: string }[]; fetchImpl: UpdateFetch } {
  const calls: (UpdateRequest & { url: string })[] = [];
  const fetchImpl: UpdateFetch = async (url, init) => {
    calls.push({ url, ...init });
    return { status, text: async () => body };
  };
  return { calls, fetchImpl };
}

async function writeCache(cache: UpdateCache): Promise<void> {
  await writeFile(dataRootPaths(root).updates, JSON.stringify(cache), { mode: 0o600 });
}

describe("version precedence", () => {
  it("orders newer, same and older versions, and prereleases", () => {
    expect(compareVersions("0.5.0", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("0.3.0", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("0.4.0", "0.4.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0-beta.2", "0.4.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0-beta.10", "0.4.0-beta.2")).toBeGreaterThan(0);
    expect(isPrerelease("0.4.0-beta.1")).toBe(true);
    expect(isPrerelease("0.4.0")).toBe(false);
  });
});

describe("which release is announced", () => {
  const stable = release("v0.4.0", { prerelease: false });
  const newer = release("v0.5.0", { prerelease: false });
  const older = release("v0.3.0", { prerelease: false });
  const beta = release("v0.5.0-beta.2");
  const draft = release("v0.9.0", { draft: true, prerelease: false });

  it("announces a newer stable release and ignores the same version, an older one and a draft", () => {
    expect(chooseRelease(CURRENT, [newer])?.version).toBe("0.5.0");
    expect(chooseRelease(CURRENT, [stable])).toBeNull();
    expect(chooseRelease(CURRENT, [older])).toBeNull();
    expect(chooseRelease(CURRENT, [draft, stable])).toBeNull();
  });

  it("ignores a prerelease unless the running version is a prerelease", () => {
    expect(chooseRelease(CURRENT, [beta, stable])).toBeNull();
    expect(chooseRelease("0.5.0-beta.1", [beta, stable])?.version).toBe("0.5.0-beta.2");
    expect(chooseRelease("0.5.0-beta.2", [beta, older])).toBeNull();
    expect(chooseRelease("0.5.0-beta.1", [newer])?.version).toBe("0.5.0");
  });
});

describe("the release request", () => {
  it("takes the repository from RELEASE_REPOSITORY, the install script's DEFAULT_REPO", async () => {
    const script = await readFile(
      new URL("../../../scripts/install-or-update-boof-runner.sh", import.meta.url),
      "utf8",
    );
    const line = script.match(/^DEFAULT_REPO="https:\/\/github\.com\/([^"]+)"/m);
    expect(line?.[1]?.replace(/\.git$/, "")).toBe(RELEASE_REPOSITORY);
    expect(releasesUrl(CURRENT)).toBe(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`,
    );
    expect(releasesUrl("0.4.0-beta.1")).toBe(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=20`,
    );
    expect(updateUserAgent(CURRENT)).toBe("boof-runner/0.4.0");
  });

  it("stores a newer release, mode 0600, and says nothing for the same or an older one", async () => {
    let now = Date.parse("2026-11-10T00:00:00.000Z");
    const newer = recorder(200, JSON.stringify(release("v0.5.0", { prerelease: false })));
    await checkForUpdate({
      root,
      version: CURRENT,
      fetchImpl: newer.fetchImpl,
      now: () => new Date(now),
    });
    expect(newer.calls).toHaveLength(1);
    expect(newer.calls[0]?.headers["user-agent"]).toBe("boof-runner/0.4.0");
    expect(Object.keys(newer.calls[0]?.headers ?? {}).sort()).toEqual(["accept", "user-agent"]);
    expect(newer.calls[0]?.redirect).toBe("error");
    expect(newer.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(newer.calls[0]?.headers).not.toHaveProperty("authorization");
    expect((await stat(dataRootPaths(root).updates)).mode & 0o777).toBe(0o600);
    const cache = await readUpdateCache(root);
    expect(cache?.latest).toEqual({
      version: "0.5.0",
      url: "https://github.com/YaminT/boof/releases/tag/v0.5.0",
      prerelease: false,
    });
    expect(uiNotice(CURRENT, cache)).toEqual({
      version: "0.5.0",
      url: "https://github.com/YaminT/boof/releases/tag/v0.5.0",
    });
    expect(cliNoticeLine(CURRENT, cache)).toBe(
      "New version available: 0.5.0 https://github.com/YaminT/boof/releases/tag/v0.5.0",
    );

    now += DAY;
    const same = recorder(200, JSON.stringify(release("v0.4.0", { prerelease: false })));
    await checkForUpdate({
      root,
      version: CURRENT,
      fetchImpl: same.fetchImpl,
      now: () => new Date(now),
    });
    expect(same.calls).toHaveLength(1);
    expect(uiNotice(CURRENT, await readUpdateCache(root))).toBeNull();

    now += DAY;
    const older = recorder(200, JSON.stringify(release("v0.3.0", { prerelease: false })));
    await checkForUpdate({
      root,
      version: CURRENT,
      fetchImpl: older.fetchImpl,
      now: () => new Date(now),
    });
    expect(older.calls).toHaveLength(1);
    expect((await readUpdateCache(root))?.latest).toBeNull();
  });

  it("asks the release list when the running version is a prerelease, and skips prereleases otherwise", async () => {
    const listed = recorder(
      200,
      JSON.stringify([release("v0.5.0-beta.2"), release("v0.4.0", { prerelease: false })]),
    );
    await checkForUpdate({ root, version: "0.5.0-beta.1", fetchImpl: listed.fetchImpl });
    expect(listed.calls[0]?.url).toContain("/releases?per_page=20");
    expect((await readUpdateCache(root))?.latest?.version).toBe("0.5.0-beta.2");

    const stable = recorder(200, JSON.stringify(release("v0.5.0-beta.9")));
    await checkForUpdate({
      root,
      version: CURRENT,
      fetchImpl: stable.fetchImpl,
      now: () => new Date(Date.now() + 2 * DAY),
    });
    expect(stable.calls[0]?.url).toContain("/releases/latest");
    expect(chooseRelease(CURRENT, parseReleases(release("v0.5.0-beta.9"))!)).toBeNull();
    expect((await readUpdateCache(root))?.latest).toBeNull();
  });

  it("sends nothing when updates.check is false", async () => {
    await new SettingsStore(root).save({ ...defaultSettings(), updates: { check: false } });
    const fake = recorder(200, JSON.stringify(release("v9.0.0", { prerelease: false })));
    await checkForUpdate({ root, version: CURRENT, fetchImpl: fake.fetchImpl });
    expect(fake.calls).toHaveLength(0);
    expect(await readUpdateCache(root)).toBeNull();
  });

  it("sends one request per 24 hours across later calls", async () => {
    let now = Date.parse("2026-11-10T00:00:00.000Z");
    const fake = recorder(200, JSON.stringify(release("v0.5.0", { prerelease: false })));
    const run = () =>
      checkForUpdate({
        root,
        version: CURRENT,
        fetchImpl: fake.fetchImpl,
        now: () => new Date(now),
      });
    await run();
    await run();
    expect(fake.calls).toHaveLength(1);
    now += DAY - 1;
    await run();
    expect(fake.calls).toHaveLength(1);
    now += 2;
    await run();
    expect(fake.calls).toHaveLength(2);
  });

  it("leaves the old cache on a 403 and on malformed JSON, and does not retry", async () => {
    const previous: UpdateCache = {
      checkedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      latest: {
        version: "0.5.0",
        url: "https://github.com/YaminT/boof/releases/tag/v0.5.0",
        prerelease: false,
      },
    };
    await writeCache(previous);
    const path = dataRootPaths(root).updates;
    const before = await readFile(path, "utf8");

    let attempts = 0;
    const forbidden: UpdateFetch = async () => {
      attempts += 1;
      return { status: 403, text: async () => '{"message":"rate limit"}' };
    };
    await checkForUpdate({ root, version: CURRENT, fetchImpl: forbidden });
    expect(attempts).toBe(1);
    expect(await readFile(path, "utf8")).toBe(before);

    const broken: UpdateFetch = async () => {
      attempts += 1;
      return { status: 200, text: async () => "{not json" };
    };
    await checkForUpdate({ root, version: CURRENT, fetchImpl: broken });
    expect(attempts).toBe(2);
    expect(await readFile(path, "utf8")).toBe(before);

    const down: UpdateFetch = async () => {
      attempts += 1;
      throw new Error("network down");
    };
    await checkForUpdate({ root, version: CURRENT, fetchImpl: down });
    expect(attempts).toBe(3);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not call GitHub from a vitest process unless a fake fetch is injected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    try {
      await checkForUpdate({ root, version: CURRENT, env: { VITEST: "true" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await readUpdateCache(root)).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not send a request from an agent environment", async () => {
    const fake = recorder(200, JSON.stringify(release("v9.0.0", { prerelease: false })));
    await checkForUpdate({
      root,
      version: CURRENT,
      fetchImpl: fake.fetchImpl,
      env: { BOOF_RUNNER_AGENT_OF: "agent-marker" },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("hides a dismissed version and shows a later one", async () => {
    const fake = recorder(200, JSON.stringify(release("v0.5.0", { prerelease: false })));
    await checkForUpdate({ root, version: CURRENT, fetchImpl: fake.fetchImpl });
    await dismissUpdate(root, "0.5.0");
    const hidden = await readUpdateCache(root);
    expect(uiNotice(CURRENT, hidden)).toBeNull();
    expect(cliNoticeLine(CURRENT, hidden)).toContain("0.5.0");

    const later = recorder(200, JSON.stringify(release("v0.6.0", { prerelease: false })));
    await checkForUpdate({
      root,
      version: CURRENT,
      fetchImpl: later.fetchImpl,
      now: () => new Date(Date.now() + DAY + 1000),
    });
    expect(uiNotice(CURRENT, await readUpdateCache(root))?.version).toBe("0.6.0");
  });
});
