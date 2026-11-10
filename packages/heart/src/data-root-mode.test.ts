import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeForSecrets,
  dataRootAccessNotice,
  isUserPrivateGroup,
  setAccountFilesForTests,
  tightenDataRoot,
  type AccountFiles,
} from "./data-root-mode.js";
import {
  parentPath,
  parseIcaclsSave,
  type AclAce,
  type AclPrincipal,
  type WindowsAclOps,
} from "./windows-acl.js";
import { ToolRegistry } from "@boof/runner";

const mocks = vi.hoisted(() => ({ home: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mocks.home ?? actual.homedir() };
});

/** Account files where the current gid is the current user's private group. */
function privateAccounts(): AccountFiles {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return {
    username: "me",
    group: `me:x:${gid}:\n`,
    passwd: `me:x:${uid}:${gid}::/home/me:/bin/sh\n`,
  };
}

const roots: string[] = [];
async function temp(): Promise<string> {
  // realpath so /var and /private/var (and Windows 8.3 names) match the path the checker uses.
  const root = await realpath(await mkdtemp(join(tmpdir(), "boof-data-mode-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  mocks.home = undefined;
  setAccountFilesForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("isUserPrivateGroup", () => {
  const passwd = "me:x:1000:1000::/h:/bin/sh\nbob:x:1001:100::/h:/bin/sh\n";
  it("accepts a group named like the user with no other member", () => {
    expect(isUserPrivateGroup(1000, 1000, { username: "me", group: "me:x:1000:\n", passwd })).toBe(
      true,
    );
    expect(
      isUserPrivateGroup(1000, 1000, { username: "me", group: "me:x:1000:me\n", passwd }),
    ).toBe(true);
  });
  it("refuses a shared primary group (users, staff)", () => {
    const shared = "me:x:1000:100::/h:/bin/sh\nbob:x:1001:100::/h:/bin/sh\n";
    expect(
      isUserPrivateGroup(1000, 100, { username: "me", group: "users:x:100:\n", passwd: shared }),
    ).toBe(false);
  });
  it("refuses a group named like the user that has another member or another primary user", () => {
    expect(
      isUserPrivateGroup(1000, 1000, { username: "me", group: "me:x:1000:bob\n", passwd }),
    ).toBe(false);
    expect(
      isUserPrivateGroup(1000, 1000, {
        username: "me",
        group: "me:x:1000:\n",
        passwd: `${passwd}bob2:x:1002:1000::/h:/bin/sh\n`,
      }),
    ).toBe(false);
  });
  it("falls back to gid === uid when /etc/group has no entry for the gid", () => {
    expect(isUserPrivateGroup(1000, 1000, { username: "me", group: "", passwd: "" })).toBe(true);
    expect(isUserPrivateGroup(501, 20, { username: "me", passwd: "" })).toBe(false);
  });
});

describe("tightenDataRoot", () => {
  it.skipIf(process.platform === "win32")("a 0755 root we own becomes 0700", async () => {
    const root = await temp();
    await chmod(root, 0o755);
    expect(await tightenDataRoot(root)).toEqual({ changed: true, before: 0o755 });
    if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("an already-private root is unchanged", async () => {
    expect(await tightenDataRoot(await temp())).toEqual({
      changed: false,
      reason: "already-private",
    });
  });

  it.skipIf(process.platform === "win32")(
    "tightens existing private subdirs and creates none",
    async () => {
      const root = await temp();
      await mkdir(join(root, "auth"), { mode: 0o777 });
      await chmod(join(root, "auth"), 0o777);
      expect(await tightenDataRoot(root)).toEqual({ changed: false, reason: "already-private" });
      if (process.platform !== "win32")
        expect((await stat(join(root, "auth"))).mode & 0o777).toBe(0o700);
      await expect(lstat(join(root, "owlish"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")("tightens n8n/ and external-runs/ to 0700", async () => {
    const root = await temp();
    for (const d of ["n8n", "external-runs"]) {
      await mkdir(join(root, d), { mode: 0o777 });
      await chmod(join(root, d), 0o775);
    }
    await tightenDataRoot(root);
    for (const d of ["n8n", "external-runs"])
      expect((await stat(join(root, d))).mode & 0o777, d).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("never touches home or /", async () => {
    const root = await temp();
    await chmod(root, 0o755);
    expect(await tightenDataRoot(root, { home: root })).toEqual({
      changed: false,
      reason: "home-or-root",
    });
    expect(await tightenDataRoot("/", { home: root })).toEqual({
      changed: false,
      reason: "home-or-root",
    });
    if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32")("reports missing roots without throwing", async () => {
    expect(await tightenDataRoot(join(await temp(), "missing"))).toEqual({
      changed: false,
      reason: "missing",
    });
  });

  it.skipIf(process.platform === "win32")("returns not-owner when uid differs", async () => {
    const root = await temp();
    const owner = (await stat(root)).uid;
    expect(await tightenDataRoot(root, { uid: owner + 1 })).toEqual({
      changed: false,
      reason: "not-owner",
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not chmod a root owned by another uid",
    async () => {
      const root = await temp();
      await chmod(root, 0o755);
      const owner = (await stat(root)).uid;
      expect(await tightenDataRoot(root, { uid: owner + 1 })).toEqual({
        changed: false,
        reason: "not-owner",
      });
      if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports root chmod failures without throwing",
    async () => {
      const root = await temp();
      await chmod(root, 0o755);
      const handle = await open(root, "r");
      const fileHandlePrototype = Object.getPrototypeOf(handle);
      await handle.close();
      vi.spyOn(fileHandlePrototype, "chmod").mockRejectedValue(
        Object.assign(new Error("permission denied"), { code: "EPERM" }),
      );
      expect(await tightenDataRoot(root)).toEqual({
        changed: false,
        reason: "chmod-failed",
        mode: 0o755,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens owned private folders even when the root chmod fails",
    async () => {
      const root = await temp();
      const auth = join(root, "auth");
      await mkdir(auth, { mode: 0o777 });
      await chmod(root, 0o755);
      await chmod(auth, 0o777);
      const handle = await open(root, "r");
      const prototype = Object.getPrototypeOf(handle);
      await handle.close();
      vi.spyOn(prototype, "chmod").mockRejectedValue(
        Object.assign(new Error("permission denied"), { code: "EPERM" }),
      );
      const tightenedPrivateDirs: string[] = [];
      const result = await tightenDataRoot(root, {
        chmod: async (path, mode) => {
          tightenedPrivateDirs.push(String(path));
          await chmod(path, mode);
        },
      });
      expect(result).toEqual({ changed: false, reason: "chmod-failed", mode: 0o755 });
      expect(tightenedPrivateDirs).toContain(auth);
      if (process.platform !== "win32") expect((await stat(auth)).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "still tightens a root under an unsafe parent and reports the parent",
    async () => {
      const base = await temp();
      const parent = join(base, "shared");
      const root = join(parent, "data");
      await mkdir(parent, { mode: 0o777 });
      await chmod(parent, 0o777);
      await mkdir(root, { mode: 0o755 });
      await chmod(root, 0o755);
      const result = await tightenDataRoot(root);
      expect(result).toMatchObject({ changed: true, before: 0o755 });
      expect(result.unsafeParent).toEqual({
        path: parent,
        message: expect.stringContaining(`chmod o-w ${parent}`),
      });
      if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o700);
    },
  );

  it("a missing path on win32 is missing and does not ask for an ACL", async () => {
    const acl = throwingAcl();
    expect(
      await tightenDataRoot(join(await temp(), "missing"), { platform: "win32", windowsAcl: acl }),
    ).toEqual({ changed: false, reason: "missing" });
    expect(acl.calls).toEqual([]);
  });
});

const me: AclPrincipal = { account: "DESKTOP\\me", sid: "S-1-5-21-1" };

function userOnly(): AclAce {
  return { sid: me.sid, allow: true, inherited: false, inheritOnly: false, rights: "FA" };
}

function everyoneWrite(): AclAce {
  return { sid: "WD", allow: true, inherited: true, inheritOnly: false, rights: "FA" };
}

function acesOf(sddl: string): AclAce[] {
  const view = parseIcaclsSave(`name\n${sddl}\n`);
  if (!view.ok) throw new Error(view.error);
  return view.aces;
}

/** `(A;OICIID;FA;;;<current user>)`, the ACE a tightened root leaves on a child. */
function inheritedUser(): AclAce[] {
  return acesOf("D:AI(A;OICIID;FA;;;S-1-5-21-1)");
}

function throwingAcl(): WindowsAclOps & { calls: string[] } {
  const calls: string[] = [];
  const boom = (name: string) => async () => {
    calls.push(name);
    throw new Error(`unexpected ${name}`);
  };
  return {
    calls,
    currentUser: boom("currentUser"),
    readAcl: boom("readAcl"),
    tightenToUser: boom("tightenToUser"),
  };
}

/** `wide` paths need a tighten; after tightenToUser they read back as the current user only. */
function scriptedAcl(wide: (path: string) => boolean): WindowsAclOps & { tightened: string[] } {
  const tightened: string[] = [];
  return {
    tightened,
    currentUser: async () => me,
    readAcl: async (path) => ({
      ok: true,
      aces: tightened.includes(path) || !wide(path) ? [userOnly()] : [userOnly(), everyoneWrite()],
    }),
    tightenToUser: async (path) => {
      tightened.push(path);
      return true;
    },
  };
}

describe("windows access list", () => {
  it("restricts a wider root to the current user and leaves the Unix mode alone", async () => {
    const root = await temp();
    await chmod(root, 0o755);
    const before = (await stat(root)).mode & 0o777;
    const acl = scriptedAcl((path) => path === root);
    const result = await tightenDataRoot(root, { platform: "win32", windowsAcl: acl });
    expect(result).toEqual({ changed: true, via: "acl" });
    expect(acl.tightened).toEqual([root]);
    expect((await stat(root)).mode & 0o777).toBe(before);
    expect(dataRootAccessNotice(root, result)).toBe(
      `tightened data root ${root}: removed other accounts from the access list (current user only)`,
    );
  });

  it("leaves an explicit user-only root alone", async () => {
    const root = await temp();
    const acl = scriptedAcl(() => false);
    expect(await tightenDataRoot(root, { platform: "win32", windowsAcl: acl })).toEqual({
      changed: false,
      reason: "already-private",
    });
    expect(acl.tightened).toEqual([]);
  });

  it("restricts an existing private subdir and does not create one", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth);
    const acl = scriptedAcl((path) => path === auth);
    expect(await tightenDataRoot(root, { platform: "win32", windowsAcl: acl })).toEqual({
      changed: true,
      via: "acl",
    });
    expect(acl.tightened).toEqual([auth]);
    await expect(lstat(join(root, "owlish"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rewrite the home directory or a filesystem root", async () => {
    const root = await temp();
    const homeAcl = throwingAcl();
    expect(
      await tightenDataRoot(root, { platform: "win32", home: root, windowsAcl: homeAcl }),
    ).toEqual({
      changed: false,
      reason: "home-or-root",
    });
    expect(homeAcl.calls).toEqual([]);
    const rootAcl = throwingAcl();
    expect(
      await tightenDataRoot("/", { platform: "win32", home: root, windowsAcl: rootAcl }),
    ).toEqual({ changed: false, reason: "home-or-root" });
    expect(rootAcl.calls).toEqual([]);
  });

  it("reports acl-failed when the write does not stick", async () => {
    const root = await temp();
    const acl: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async () => ({ ok: true, aces: [userOnly(), everyoneWrite()] }),
      tightenToUser: async () => false,
    };
    const result = await tightenDataRoot(root, { platform: "win32", windowsAcl: acl });
    expect(result.changed).toBe(false);
    if (result.changed || result.reason !== "acl-failed") throw new Error("expected acl-failed");
    expect(result.message).toContain("icacls");
    expect(result.message).toContain(me.sid);
    expect(dataRootAccessNotice(root, result)).toBe(`warning: ${result.message}`);
  });

  it("warns when a parent grants write to someone other than the user, SYSTEM or Administrators", async () => {
    const base = await temp();
    const parent = join(base, "shared");
    const root = join(parent, "data");
    await mkdir(parent);
    await mkdir(root);
    const benign: AclAce[] = [
      { sid: "SY", allow: true, inherited: false, inheritOnly: false, rights: "FA" },
      { sid: "BA", allow: true, inherited: false, inheritOnly: false, rights: "FA" },
      userOnly(),
    ];
    const quiet: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async (path) => ({ ok: true, aces: path === parent ? benign : [userOnly()] }),
      tightenToUser: async () => true,
    };
    expect(await tightenDataRoot(root, { platform: "win32", windowsAcl: quiet })).toEqual({
      changed: false,
      reason: "already-private",
    });
    const shared: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async (path) => ({
        ok: true,
        aces: path === parent ? [userOnly(), everyoneWrite()] : [userOnly()],
      }),
      tightenToUser: async () => true,
    };
    const result = await tightenDataRoot(root, { platform: "win32", windowsAcl: shared });
    expect(result).toMatchObject({ changed: false, reason: "already-private" });
    expect(result.unsafeParent).toEqual({
      path: parentPath(root),
      message: expect.stringContaining("S-1-1-0"),
    });
    expect(parentPath(root)).toBe(parent);
  });

  it("accepts a user-only root and refuses a wider secret directory", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth);
    const ok = scriptedAcl(() => false);
    await expect(
      assertSafeForSecrets(root, auth, "directory", { platform: "win32", windowsAcl: ok }),
    ).resolves.toBeUndefined();
    const wide = scriptedAcl((path) => path === auth);
    await expect(
      assertSafeForSecrets(root, auth, "directory", { platform: "win32", windowsAcl: wide }),
    ).rejects.toThrow(/icacls/);
    expect(wide.tightened).toEqual([]);
  });

  it("tightens a wider root once during a secret check, then accepts it", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth);
    const acl = scriptedAcl((path) => path === root);
    await expect(
      assertSafeForSecrets(root, auth, "directory", { platform: "win32", windowsAcl: acl }),
    ).resolves.toBeUndefined();
    expect(acl.tightened).toEqual([root]);
  });

  it("refuses a shared parent and a symlink in place of the secret directory", async () => {
    const base = await temp();
    const parent = join(base, "shared");
    const root = join(parent, "data");
    await mkdir(parent);
    await mkdir(root);
    const auth = join(root, "auth");
    await mkdir(auth);
    const shared: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async (path) => ({
        ok: true,
        aces: path === parent ? [everyoneWrite()] : [userOnly()],
      }),
      tightenToUser: async () => true,
    };
    await expect(
      assertSafeForSecrets(root, auth, "directory", { platform: "win32", windowsAcl: shared }),
    ).rejects.toThrow(/other accounts/);
    const link = join(root, "linked");
    await symlink(auth, link);
    const ok = scriptedAcl(() => false);
    await expect(
      assertSafeForSecrets(root, link, "directory", { platform: "win32", windowsAcl: ok }),
    ).rejects.toThrow(/symbolic link/);
  });

  it("accepts an inherited full-control ACE for the current user on a child file and folder", async () => {
    const root = await temp();
    const folder = join(root, "auth");
    await mkdir(folder);
    const file = join(folder, "clients.json");
    await writeFile(file, "{}\n");
    const inherited = inheritedUser();
    const acl: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async (path) => ({
        ok: true,
        aces: path === folder || path === file ? inherited : [userOnly()],
      }),
      tightenToUser: async () => {
        throw new Error(
          "a child with only the current user's inherited allow must not be rewritten",
        );
      },
    };
    await expect(
      assertSafeForSecrets(root, folder, "directory", { platform: "win32", windowsAcl: acl }),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeForSecrets(root, file, "file", { platform: "win32", windowsAcl: acl }),
    ).resolves.toBeUndefined();
  });

  it("refuses an inherited ACE for another account on a child file and folder", async () => {
    const root = await temp();
    const folder = join(root, "auth");
    await mkdir(folder);
    const file = join(folder, "clients.json");
    await writeFile(file, "{}\n");
    const wider = acesOf("D:AI(A;OICIID;FA;;;S-1-5-21-1)(A;OICIID;FR;;;WD)");
    const acl: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async (path) => ({
        ok: true,
        aces: path === folder || path === file ? wider : [userOnly()],
      }),
      tightenToUser: async () => false,
    };
    await expect(
      assertSafeForSecrets(root, folder, "directory", { platform: "win32", windowsAcl: acl }),
    ).rejects.toThrow(/icacls/);
    await expect(
      assertSafeForSecrets(root, file, "file", { platform: "win32", windowsAcl: acl }),
    ).rejects.toThrow(/icacls/);
  });

  it("refuses a conditional ACE on a child file", async () => {
    const root = await temp();
    const folder = join(root, "auth");
    await mkdir(folder);
    const file = join(folder, "clients.json");
    await writeFile(file, "{}\n");
    const conditional = acesOf(
      'D:(XA;ID;FA;;;S-1-5-21-1;(@User.Title=="PM"))(A;ID;FA;;;S-1-5-21-1)',
    );
    const acl: WindowsAclOps = {
      currentUser: async () => me,
      readAcl: async (path) => ({
        ok: true,
        aces: path === file ? conditional : [userOnly()],
      }),
      tightenToUser: async () => false,
    };
    await expect(
      assertSafeForSecrets(root, file, "file", { platform: "win32", windowsAcl: acl }),
    ).rejects.toThrow(/icacls/);
  });

  it("refuses a secret path outside the data root", async () => {
    const root = await temp();
    const acl = scriptedAcl(() => false);
    await expect(
      assertSafeForSecrets(root, join(await temp(), "elsewhere"), "directory", {
        platform: "win32",
        windowsAcl: acl,
      }),
    ).rejects.toThrow(/outside the data root/);
  });
});

describe("assertSafeForSecrets", () => {
  it.skipIf(process.platform === "win32")(
    "accepts the data root when an ancestor directory is a symlink",
    async () => {
      const base = await temp();
      const real = join(base, "real");
      const link = join(base, "link");
      await mkdir(real, { mode: 0o755 });
      await symlink(real, link);
      const root = join(link, "data");
      await mkdir(root, { mode: 0o700 });
      await mkdir(join(root, "auth"), { mode: 0o700 });
      await expect(
        assertSafeForSecrets(root, root, "directory", { accounts: privateAccounts() }),
      ).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")("accepts a primary-group 0775 parent", async () => {
    const base = await temp();
    const parent = join(base, "boof-runner");
    const root = join(parent, "data");
    await mkdir(parent, { mode: 0o775 });
    await chmod(parent, 0o775);
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "auth"), { mode: 0o700 });
    await expect(
      assertSafeForSecrets(root, join(root, "auth"), "directory", { accounts: privateAccounts() }),
    ).resolves.toBeUndefined();
  });

  /** A 0775 parent over `data/auth`; returns the paths. */
  async function groupWritableParent() {
    const base = await temp();
    const parent = join(base, "boof-runner");
    const root = join(parent, "data");
    await mkdir(parent, { mode: 0o775 });
    await chmod(parent, 0o775);
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "auth"), { mode: 0o700 });
    return { parent, root, auth: join(root, "auth") };
  }

  it.skipIf(process.platform === "win32")(
    "refuses a group-writable owned parent of any other group",
    async () => {
      const { parent, root, auth } = await groupWritableParent();
      const uid = process.getuid!();
      const otherGroup = async (path: string) => {
        const value = await stat(path);
        return path === parent
          ? new Proxy(value, {
              get: (target, key) =>
                key === "gid" ? value.gid + 1 : Reflect.get(target, key, target),
            })
          : value;
      };
      await expect(
        assertSafeForSecrets(root, auth, "directory", {
          uid,
          stat: otherGroup,
          // Even a private-looking group is refused when it is not the process's own gid.
          accounts: {
            ...privateAccounts(),
            group: `me:x:${process.getgid!() + 1}:\n`,
          },
        }),
      ).rejects.toThrow(`chmod g-w ${parent}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a group-writable parent whose group is shared (users, staff)",
    async () => {
      const { parent, root, auth } = await groupWritableParent();
      const uid = process.getuid!();
      const gid = process.getgid!();
      const shared: AccountFiles = {
        username: "me",
        group: `users:x:${gid}:\n`,
        passwd: `me:x:${uid}:${gid}::/home/me:/bin/sh\nother:x:${uid + 1}:${gid}::/home/o:/bin/sh\n`,
      };
      await expect(
        assertSafeForSecrets(root, auth, "directory", { accounts: shared }),
      ).rejects.toThrow(`chmod g-w ${parent}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts a group-writable parent in the user's private group",
    async () => {
      const { root, auth } = await groupWritableParent();
      await expect(
        assertSafeForSecrets(root, auth, "directory", { accounts: privateAccounts() }),
      ).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "pins owner checks for clients.json and auth",
    async () => {
      const root = await temp();
      const auth = join(root, "auth");
      const clients = join(auth, "clients.json");
      await mkdir(auth, { mode: 0o700 });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(clients, "{}", { mode: 0o600 });
      const uid = process.getuid!();
      const other = uid + 1;
      const foreign = (value: Awaited<ReturnType<typeof stat>>) =>
        new Proxy(value, {
          get: (target, key) => (key === "uid" ? other : Reflect.get(target, key, target)),
        });
      const lstatClients = async (path: string) => {
        const value = await import("node:fs/promises").then(({ lstat }) => lstat(path));
        return path === clients ? foreign(value) : value;
      };
      await expect(
        assertSafeForSecrets(root, clients, "file", { uid, lstat: lstatClients }),
      ).rejects.toThrow(/owned by uid/);
      const lstatAuth = async (path: string) => {
        const value = await import("node:fs/promises").then(({ lstat }) => lstat(path));
        return path === auth ? foreign(value) : value;
      };
      await expect(
        assertSafeForSecrets(root, auth, "directory", { uid, lstat: lstatAuth }),
      ).rejects.toThrow(/owned by uid/);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a foreign-owned data root", async () => {
    const root = await temp();
    const uid = process.getuid!();
    const fakeOwner = (value: Awaited<ReturnType<typeof stat>>) =>
      new Proxy(value, {
        get: (target, key) => (key === "uid" ? uid + 1 : Reflect.get(target, key, target)),
      });
    const statForeign = vi.fn(async (path: string) => {
      const value = await stat(path);
      return path === root ? fakeOwner(value) : value;
    });
    let rootOpenCount = 0;
    const openForeign = (async (path: string) => {
      const handle = await open(path, "r");
      if (path !== root) return handle;
      rootOpenCount += 1;
      if (rootOpenCount > 1) return handle;
      return {
        stat: async () => fakeOwner(await handle.stat()),
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof open>>;
    }) as typeof open;
    await expect(
      assertSafeForSecrets(root, root, "directory", {
        uid,
        stat: statForeign,
        open: openForeign,
      }),
    ).rejects.toThrow(`${root} is owned by uid ${uid + 1}`);
    expect(statForeign).toHaveBeenCalledWith(root);
  });

  it.skipIf(process.platform === "win32")("refuses a foreign-owned middle symlink", async () => {
    const base = await temp();
    const real = join(base, "real");
    const middle = join(base, "middle");
    const top = join(base, "top");
    await mkdir(real, { mode: 0o700 });
    await mkdir(join(real, "auth"), { mode: 0o700 });
    await symlink(real, middle);
    await symlink(middle, top);
    const uid = process.getuid!();
    const lstat = async (path: string) => {
      const { lstat } = await import("node:fs/promises");
      const value = await lstat(path);
      return path === middle
        ? new Proxy(value, {
            get: (target, key) => (key === "uid" ? uid + 1 : Reflect.get(target, key, target)),
          })
        : value;
    };
    await expect(
      assertSafeForSecrets(top, join(top, "auth"), "directory", { uid, lstat }),
    ).rejects.toThrow(/symbolic link owned by uid/);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a world-writable non-sticky link parent",
    async () => {
      const base = await temp();
      const real = join(base, "real");
      const shared = join(base, "shared");
      const top = join(shared, "top");
      await mkdir(real, { mode: 0o700 });
      await mkdir(join(real, "auth"), { mode: 0o700 });
      await mkdir(shared, { mode: 0o777 });
      await chmod(shared, 0o777);
      await symlink(real, top);
      await expect(assertSafeForSecrets(top, join(top, "auth"), "directory")).rejects.toThrow(
        /world-writable/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "only accepts sticky ancestors owned by root or us",
    async () => {
      const base = await temp();
      const parent = join(base, "sticky");
      const root = join(parent, "data");
      await mkdir(parent, { mode: 0o1777 });
      await chmod(parent, 0o1777);
      await mkdir(root, { mode: 0o700 });
      await mkdir(join(root, "auth"), { mode: 0o700 });
      const uid = process.getuid!();
      const statForeign = async (path: string) => {
        const value = await stat(path);
        return path === parent
          ? new Proxy(value, {
              get: (target, key) => (key === "uid" ? uid + 1 : Reflect.get(target, key, target)),
            })
          : value;
      };
      await expect(
        assertSafeForSecrets(root, join(root, "auth"), "directory", { uid, stat: statForeign }),
      ).rejects.toThrow(/owned by uid/);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a non-root foreign-owned ancestor", async () => {
    const base = await temp();
    const parent = join(base, "parent");
    const root = join(parent, "data");
    await mkdir(parent, { mode: 0o755 });
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "auth"), { mode: 0o700 });
    const uid = process.getuid!();
    const statForeign = async (path: string) => {
      const value = await stat(path);
      return path === parent
        ? new Proxy(value, {
            get: (target, key) => (key === "uid" ? uid + 1 : Reflect.get(target, key, target)),
          })
        : value;
    };
    await expect(
      assertSafeForSecrets(root, join(root, "auth"), "directory", { uid, stat: statForeign }),
    ).rejects.toThrow(/owned by uid/);
  });

  it.skipIf(process.platform === "win32")("protects os.homedir when HOME is unset", async () => {
    // A temp folder stands in for the home folder; the real one is never touched.
    const fakeHome = await temp();
    await chmod(fakeHome, 0o755);
    mocks.home = fakeHome;
    vi.stubEnv("HOME", undefined);
    try {
      expect(await tightenDataRoot(fakeHome)).toEqual({ changed: false, reason: "home-or-root" });
      if (process.platform !== "win32") expect((await stat(fakeHome)).mode & 0o777).toBe(0o755);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")("refuses and never chmods $HOME at 0775", async () => {
    const home = await temp();
    await chmod(home, 0o775);
    await mkdir(join(home, "auth"), { mode: 0o700 });
    await expect(
      assertSafeForSecrets(home, join(home, "auth"), "directory", {
        home,
        accounts: privateAccounts(),
      }),
    ).rejects.toThrow(`chmod go-w ${home}`);
    if (process.platform !== "win32") expect((await stat(home)).mode & 0o777).toBe(0o775);
  });

  it.skipIf(process.platform === "win32")(
    "refuses an owned data root with write bits for others when chmod does not take",
    async () => {
      const root = await temp();
      await chmod(root, 0o777);
      await mkdir(join(root, "auth"), { mode: 0o700 });
      const noChmod: typeof open = async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        handle.chmod = async () => {};
        return handle;
      };
      await expect(
        assertSafeForSecrets(root, join(root, "auth"), "directory", { open: noChmod }),
      ).rejects.toThrow(`chmod go-w ${root}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts the owned auth directory and regular file",
    async () => {
      const root = await temp();
      await mkdir(join(root, "auth"), { mode: 0o700 });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, "auth", "clients.json"), "{}", { mode: 0o600 });
      await expect(
        assertSafeForSecrets(root, join(root, "auth", "clients.json"), "file"),
      ).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes group/world write from an owned data root",
    async () => {
      const root = await temp();
      await chmod(root, 0o775);
      await mkdir(join(root, "auth"), { mode: 0o700 });
      await expect(
        assertSafeForSecrets(root, join(root, "auth"), "directory"),
      ).resolves.toBeUndefined();
      if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === "win32")("refuses group-writable auth directories", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth, { mode: 0o700 });
    await chmod(auth, 0o770);
    await expect(assertSafeForSecrets(root, auth, "directory")).rejects.toThrow(/chmod 700/);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked secret file", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth, { mode: 0o700 });
    const target = join(root, "outside.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, join(auth, "clients.json"));
    await expect(assertSafeForSecrets(root, join(auth, "clients.json"), "file")).rejects.toThrow(
      /regular file/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects roots below writable non-sticky ancestors",
    async () => {
      const root = await temp();
      const unsafeParent = join(root, "shared");
      await mkdir(unsafeParent, { mode: 0o777 });
      await chmod(unsafeParent, 0o777);
      const nested = join(unsafeParent, "data");
      await mkdir(nested, { mode: 0o700 });
      await mkdir(join(nested, "auth"), { mode: 0o700 });
      await expect(assertSafeForSecrets(nested, join(nested, "auth"), "directory")).rejects.toThrow(
        /world-writable/,
      );
    },
  );

  it.skipIf(process.platform === "win32")("checks owner of links in a symlink chain", async () => {
    const root = await temp();
    const real = join(root, "real");
    await mkdir(real, { mode: 0o700 });
    await mkdir(join(real, "auth"), { mode: 0o700 });
    const first = join(root, "first");
    const second = join(root, "second");
    await symlink(real, first);
    await symlink(first, second);
    await expect(
      assertSafeForSecrets(second, join(second, "auth"), "directory"),
    ).resolves.toBeUndefined();
    const uid = (await stat(root)).uid;
    const foreignMiddle = async (path: string) => {
      const entry = await lstat(path);
      if (path !== first) return entry;
      return new Proxy(entry, {
        get: (target, key) => (key === "uid" ? uid + 1 : Reflect.get(target, key, target)),
      });
    };
    await expect(
      assertSafeForSecrets(second, join(second, "auth"), "directory", {
        uid,
        lstat: foreignMiddle,
      }),
    ).rejects.toThrow(/symbolic link owned by uid/);
  });

  it.skipIf(process.platform === "win32")(
    "startServer tightens an open root and logs the change once",
    async () => {
      const root = await temp();
      await chmod(root, 0o755);
      const warnings: string[] = [];
      const { startServer } = await import("../../heart-server/src/server/server.js");
      const running = await startServer({
        root,
        port: 0,
        catalog: new ToolRegistry([]),
        warn: (message) => warnings.push(message),
      });
      try {
        if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect(warnings.filter((message) => message.includes("tightened data root"))).toEqual([
          `tightened data root ${root} from 755 to 700 (other local users could read it)`,
        ]);
      } finally {
        await running.stop();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "startServer under an unsafe parent tightens the root and names the parent, not chmod 700",
    async () => {
      const base = await temp();
      const parent = join(base, "shared");
      const root = join(parent, "data");
      await mkdir(parent, { mode: 0o777 });
      await chmod(parent, 0o777);
      await mkdir(root, { mode: 0o755 });
      await chmod(root, 0o755);
      const warnings: string[] = [];
      const { startServer } = await import("../../heart-server/src/server/server.js");
      const running = await startServer({
        root,
        port: 0,
        catalog: new ToolRegistry([]),
        warn: (message) => warnings.push(message),
      });
      try {
        if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect(warnings.some((m) => m.includes(`chmod o-w ${parent}`))).toBe(true);
        expect(warnings.some((m) => m.includes("chmod 700"))).toBe(false);
      } finally {
        await running.stop();
      }
    },
  );
});
