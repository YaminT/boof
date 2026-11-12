/**
 * How the desktop start smoke launches the app.
 * Linux release smoke runs the AppImage. `--appimage-extract-and-run` avoids FUSE,
 * which GitHub-hosted runners do not provide. `--no-sandbox` is smoke-only: the
 * Chromium sandbox needs user namespaces those runners block. Other systems start
 * the staged app under the Electron binary, the same way a local `electron .` does.
 *
 * @param {{
 *   launch?: string | undefined,
 *   appImage?: string | undefined,
 *   electronBin?: string | undefined,
 *   stagedApp: string,
 *   userData: string,
 * }} input
 */
export function smokeCommand(input) {
  const userDataArg = `--user-data-dir=${input.userData}`;
  const launch = input.launch ?? "staged";
  if (launch === "appimage") {
    if (!input.appImage) throw new Error("appimage smoke requires the AppImage path");
    return {
      command: input.appImage,
      // xvfb has no GPU. --disable-gpu still starts a GPU process, and a failed
      // launch aborts the app ("GPU process isn't usable"). --in-process-gpu keeps
      // that work in the browser process. --no-zygote avoids the Linux zygote,
      // which dies under AppImage extract-and-run on some hosts and then fails
      // every child launch. These flags are smoke-only.
      args: [
        "--appimage-extract-and-run",
        userDataArg,
        "--no-sandbox",
        "--disable-gpu",
        "--in-process-gpu",
        "--no-zygote",
      ],
    };
  }
  if (launch !== "staged") throw new Error(`unknown smoke launch: ${launch}`);
  if (!input.electronBin) throw new Error("staged smoke requires the Electron binary");
  return { command: input.electronBin, args: [userDataArg, input.stagedApp] };
}
