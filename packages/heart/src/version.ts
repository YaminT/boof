/** The boof-runner version (kept equal to the root package.json; a test checks it). */
export const BOOF_VERSION = "0.5.0";

/**
 * GitHub `owner/name` that publishes releases. This is the owner and name of
 * `DEFAULT_REPO` in `scripts/install-or-update-boof-runner.sh`. The update check
 * builds its API URL from this constant; do not copy the repository anywhere else.
 */
export const RELEASE_REPOSITORY = "YaminT/boof";
