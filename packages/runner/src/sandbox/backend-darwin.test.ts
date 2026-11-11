import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxLaunchPolicy } from "@boof/heart";
import { planDarwinSandbox, renderSeatbeltProfile } from "./backend-darwin.js";

const policy: SandboxLaunchPolicy = {
  version: 1,
  readExec: ["/usr", "/bin"],
  readWrite: ["/work", "/dev/null"],
  denyTcpPorts: [9, 8080],
  env: { FOO: "bar" },
};

function profile(over: Partial<SandboxLaunchPolicy> = {}): string {
  return renderSeatbeltProfile({ ...policy, ...over });
}

describe("renderSeatbeltProfile", () => {
  it("denies by default and grants paths with subpath", () => {
    const text = profile();
    expect(text.startsWith("(version 1)\n(deny default)\n")).toBe(true);
    expect(text).toContain("(allow process-exec*)\n");
    expect(text).toContain("(allow dynamic-code-generation)\n");
    expect(text).toContain('(allow file-read-data (literal "/"))\n');
    expect(text).not.toContain('(subpath "/")');
    expect(text).not.toContain("(allow process*)\n");
    expect(text).toContain("(allow process-fork)\n");
    expect(text).toContain("(allow signal (target same-sandbox))\n");
    expect(text).toContain("(allow sysctl-read)\n");
    expect(text).toContain(
      '(allow file-read* file-map-executable\n  (subpath "/usr")\n  (subpath "/bin")\n)',
    );
    expect(text).toContain(
      '(allow file-read* file-write* file-map-executable\n  (subpath "/work")\n  (subpath "/dev/null")\n)',
    );
    const readAt = text.indexOf("(allow file-read* file-map-executable\n");
    const writeAt = text.indexOf("(allow file-read* file-write*");
    expect(text.slice(readAt, writeAt)).not.toContain('"/work"');
  });

  it("allows every TCP port and then denies the listed protected ports", () => {
    const text = profile();
    const allowAt = text.indexOf('(allow network-outbound (remote ip "*:*"))');
    const bindAllow = text.indexOf('(allow network-bind (local ip "*:*"))');
    const denyOut = text.indexOf('(deny network-outbound (remote ip "*:9"))');
    const denyBind = text.indexOf('(deny network-bind (local ip "*:9"))');
    const denyIn = text.indexOf('(deny network-inbound (local ip "*:9"))');
    expect(allowAt).toBeGreaterThan(0);
    expect(bindAllow).toBeGreaterThan(allowAt);
    expect(denyOut).toBeGreaterThan(bindAllow);
    expect(denyBind).toBeGreaterThan(denyOut);
    expect(denyIn).toBeGreaterThan(denyBind);
    expect(text).toContain('(deny network-outbound (remote ip "*:8080"))');
    expect(text).toContain('(deny network-bind (local ip "*:8080"))');
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("::1");
  });

  it("does not allow unix-socket paths or the Keychain", () => {
    const text = profile();
    expect(text).not.toContain("unix-socket");
    expect(text).not.toContain("SecurityServer");
    expect(text).not.toContain("securityd");
    expect(text).toContain("(allow system-socket (socket-domain AF_UNIX))");
    expect(text).not.toContain("(allow ipc-posix-shm)");
  });

  it("does not grant the whole device tree", () => {
    const text = profile({ readExec: ["/usr"], readWrite: ["/dev/null"] });
    expect(text).not.toContain('(subpath "/dev")');
    expect(text).not.toContain('(subpath "/dev/ttys');
  });

  it("quotes a path that contains a space", () => {
    expect(profile({ readWrite: ["/tmp/my dir"] })).toContain('(subpath "/tmp/my dir")');
  });

  it("grants both spellings of a /var, /tmp or /etc path without widening the root", () => {
    const text = profile({
      readExec: ["/private/etc", "/tmp/tool"],
      readWrite: ["/private/var/folders/abc/work"],
    });
    expect(text).toContain('(subpath "/private/etc")');
    expect(text).toContain('(subpath "/etc")');
    expect(text).toContain('(subpath "/tmp/tool")');
    expect(text).toContain('(subpath "/private/tmp/tool")');
    expect(text).toContain('(subpath "/private/var/folders/abc/work")');
    expect(text).toContain('(subpath "/var/folders/abc/work")');
    expect(text).not.toContain('(subpath "/var")\n');
    expect(text).not.toContain('(subpath "/private/var")\n');
    expect(text).not.toContain('(subpath "/tmp")\n');
    expect(text).not.toContain('(subpath "/private/tmp")\n');
  });

  it.each([
    ['/tmp/bad"path'],
    ["/tmp/bad'path"],
    ["/tmp/bad\npath"],
    ["/tmp/bad\rpath"],
    ["/tmp/bad\\path"],
  ])("refuses a path that cannot be quoted (%j)", (path) => {
    expect(() => profile({ readExec: [path] })).toThrow(/quote or newline/);
  });

  it("refuses a corrupt policy", () => {
    expect(() => profile({ version: 2 } as Partial<SandboxLaunchPolicy>)).toThrow(
      /sandbox policy is corrupt/,
    );
    expect(() => renderSeatbeltProfile({ ...policy, extra: true } as SandboxLaunchPolicy)).toThrow(
      /sandbox policy is corrupt/,
    );
  });
});

describe("planDarwinSandbox", () => {
  const saved = process.env.BOOF_SANDBOX_EXEC;

  afterEach(() => {
    if (saved === undefined) delete process.env.BOOF_SANDBOX_EXEC;
    else process.env.BOOF_SANDBOX_EXEC = saved;
  });

  it("runs sandbox-exec -p with the profile and closes the unused policy pipe", () => {
    process.env.BOOF_SANDBOX_EXEC = "/bin/true";
    const plan = planDarwinSandbox(
      { kind: "sandbox", policy, helper: "/no/such/boof-sandbox" },
      "/bin/echo",
      ["hi"],
      { PATH: "/bin" },
    );
    expect(plan.command).toBe("/bin/true");
    expect(plan.args[0]).toBe("-p");
    expect(plan.args[1]).toContain("(deny default)");
    expect(plan.args.slice(2)).toEqual(["/bin/echo", "hi"]);
    expect(plan.env.PATH).toBe("/bin");
    expect(plan.env.FOO).toBe("bar");
    expect(plan.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
    const end = vi.fn();
    plan.deliver({ stdio: [undefined, undefined, undefined, { end }] });
    expect(end).toHaveBeenCalledOnce();
  });

  it("refuses a missing sandbox-exec before spawn", () => {
    process.env.BOOF_SANDBOX_EXEC = "/no/such/sandbox-exec";
    expect(() =>
      planDarwinSandbox({ kind: "sandbox", policy, helper: "/bin/true" }, "/bin/echo", [], {}),
    ).toThrow(/sandbox-exec is missing/);
  });
});
