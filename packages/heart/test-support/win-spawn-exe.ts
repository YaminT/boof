import { execFile } from "node:child_process";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * libuv's `spawn` only starts `.com` and `.exe`. A `git.cmd` or a shebang script earlier on PATH
 * is invisible, so the real `git.exe` runs and a test double never sees the command. This builds
 * one real executable that reads a sidecar and starts either `sh.path`'s shell on `./git` or
 * `node.path`'s node on `./payload.mjs`, forwarding argv and stdio. Paths live in files because
 * an agent environment drops `BOOF_*`.
 */
const LAUNCHER = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class Launch {
  static string Quote(string s) {
    if (s.Length != 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
    var sb = new StringBuilder();
    sb.Append('"');
    int slashes = 0;
    foreach (char c in s) {
      if (c == '\\\\') { slashes++; continue; }
      if (c == '"') {
        sb.Append('\\\\', slashes * 2 + 1);
        sb.Append('"');
        slashes = 0;
        continue;
      }
      if (slashes > 0) { sb.Append('\\\\', slashes); slashes = 0; }
      sb.Append(c);
    }
    if (slashes > 0) sb.Append('\\\\', slashes * 2);
    sb.Append('"');
    return sb.ToString();
  }

  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string nodeFile = Path.Combine(dir, "node.path");
    string shFile = Path.Combine(dir, "sh.path");
    string file;
    string script;
    if (File.Exists(nodeFile)) {
      file = File.ReadAllText(nodeFile).Trim();
      script = Path.Combine(dir, "payload.mjs");
    } else if (File.Exists(shFile)) {
      file = File.ReadAllText(shFile).Trim();
      script = Path.Combine(dir, "git");
    } else {
      Console.Error.WriteLine("win-spawn-exe: no node.path or sh.path next to the executable");
      return 127;
    }
    var sb = new StringBuilder();
    sb.Append(Quote(script));
    foreach (string a in args) {
      sb.Append(' ');
      sb.Append(Quote(a));
    }
    var psi = new ProcessStartInfo();
    psi.FileName = file;
    psi.Arguments = sb.ToString();
    psi.UseShellExecute = false;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.CreateNoWindow = true;
    Process p = Process.Start(psi);
    if (p == null) return 127;
    System.Threading.Thread tOut = new System.Threading.Thread(() => {
      try { p.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); }
      catch (IOException) {}
    });
    System.Threading.Thread tErr = new System.Threading.Thread(() => {
      try { p.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); }
      catch (IOException) {}
    });
    tOut.Start();
    tErr.Start();
    try { Console.OpenStandardInput().CopyTo(p.StandardInput.BaseStream); }
    catch (IOException) {}
    try { p.StandardInput.Close(); } catch (IOException) {}
    p.WaitForExit();
    tOut.Join();
    tErr.Join();
    return p.ExitCode;
  }
}
`;

let cached: Promise<string> | undefined;

async function cscCompiler(): Promise<string> {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try the other framework directory */
    }
  }
  throw new Error("csc.exe was not found; a Windows spawn shim needs the .NET Framework compiler");
}

function compileLauncher(): Promise<string> {
  cached ??= (async () => {
    const dir = join(tmpdir(), "boof-win-spawn-exe");
    await mkdir(dir, { recursive: true });
    const cs = join(dir, "Launch.cs");
    const exe = join(dir, "launch.exe");
    await writeFile(cs, LAUNCHER);
    const csc = await cscCompiler();
    await new Promise<void>((resolve, reject) => {
      execFile(
        csc,
        ["/nologo", "/optimize+", "/target:exe", `/out:${exe}`, cs],
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`csc failed: ${stderr || err.message}`));
          else resolve();
        },
      );
    });
    return exe;
  })();
  return cached;
}

/** Copy the launcher to `destExe` (for example `git.exe` or `codex.exe`). */
export async function installWinLauncher(destExe: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("installWinLauncher is only for Windows");
  }
  await copyFile(await compileLauncher(), destExe);
}
