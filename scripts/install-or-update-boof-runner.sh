#!/usr/bin/env bash
set -Eeuo pipefail

IFS=$'\n\t'

APP_NAME="boof-runner"
DEFAULT_REPO="https://github.com/YaminT/boof.git"
DEFAULT_DIR="${XDG_DATA_HOME:-"$HOME/.local/share"}/boof-runner/source"

REPO_URL="${BOOF_RUNNER_REPO:-$DEFAULT_REPO}"
INSTALL_DIR="${BOOF_RUNNER_DIR:-$DEFAULT_DIR}"
BRANCH="${BOOF_RUNNER_BRANCH:-}"
SKIP_UPDATE="${BOOF_RUNNER_SKIP_UPDATE:-0}"
INSTALL_MODE="${BOOF_RUNNER_INSTALL_MODE:-link}"
SKIP_DESKTOP="${BOOF_RUNNER_SKIP_DESKTOP:-auto}"
FORCE_UPDATE="${BOOF_RUNNER_FORCE_UPDATE:-0}"

log() {
  printf '[%s] %s\n' "$APP_NAME" "$*" >&2
}

die() {
  printf '[%s] error: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install or update boof-runner from source.

Usage:
  scripts/install-or-update-boof-runner.sh

Environment:
  BOOF_RUNNER_REPO          Git remote to clone when no checkout is found.
  BOOF_RUNNER_DIR           Install/update directory for cloned source.
  BOOF_RUNNER_BRANCH        Branch/tag to checkout before building.
  BOOF_RUNNER_SKIP_UPDATE   Set to 1 to build/link without pulling.
  BOOF_RUNNER_INSTALL_MODE  link (npm link) or copy (npm install -g <checkout>; npm 7+ links the
                            directory too, so both resolve dependencies from the checkout).
                            Default: link.
  BOOF_RUNNER_SKIP_DESKTOP  1: do not download Electron or build the desktop app (web UI + CLI only).
                            0: always build everything. Default: 1 on Linux without DISPLAY or
                            WAYLAND_DISPLAY (a headless server), otherwise 0.
  BOOF_RUNNER_FORCE_UPDATE  Set to 1 to update a checkout that has uncommitted changes. They are
                            saved first to <install dir>/../backups/<timestamp>.patch (plus a .tar.gz
                            of untracked files), then the checkout is reset to HEAD.

An existing checkout with uncommitted changes is never touched unless BOOF_RUNNER_FORCE_UPDATE=1.

Examples:
  ./scripts/install-or-update-boof-runner.sh
  BOOF_RUNNER_BRANCH=main bash scripts/install-or-update-boof-runner.sh
  BOOF_RUNNER_REPO=git@github.com:YaminT/boof.git bash scripts/install-or-update-boof-runner.sh   # SSH, to push with your key
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# The engines.node range of the checkout's package.json, e.g. ">=22.22".
node_floor() {
  node -p 'require(process.argv[1]).engines.node' "$1/package.json"
}

# node_version_ok <version> <range>: exit 0 when <version> (with or without a leading v) satisfies
# a ">=X.Y[.Z]" range, comparing major, minor and patch numerically (missing parts are 0).
node_version_ok() {
  node -e '
    const [version, range] = process.argv.slice(1);
    const m = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range);
    if (!m) process.exit(2);
    const parse = (s) => {
      const p = s.replace(/^v/, "").split(".").map(Number);
      return [p[0] || 0, p[1] || 0, p[2] || 0];
    };
    const have = parse(version);
    const want = parse(m[1]);
    for (let i = 0; i < 3; i++) {
      if (have[i] !== want[i]) process.exit(have[i] > want[i] ? 0 : 1);
    }
    process.exit(0);
  ' "$1" "$2"
}

# Needs the checkout (its package.json), so it runs after source_dir.
check_node() {
  local checkout="$1" floor
  need_cmd node
  floor="$(node_floor "$checkout")"
  node_version_ok "$(node --version)" "$floor" ||
    die "Node.js $floor is required (package.json engines); found $(node --version)"
}

script_checkout_root() {
  local script="${BASH_SOURCE[0]:-}"
  [[ -n "$script" && -f "$script" ]] || return 1

  local dir
  dir="$(cd "$(dirname "$script")" && pwd -P)"
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null || return 1
}

is_boof_runner_checkout() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(pkg.name === "boof-runner" ? 0 : 1);
  ' "$dir/package.json"
}

tracked_changes_exist() {
  [[ -n "$(git -C "$1" status --porcelain --untracked-files=no)" ]]
}

# True when the desktop app (Electron) must not be installed or built.
skip_desktop() {
  case "$SKIP_DESKTOP" in
    1) return 0 ;;
    0) return 1 ;;
    auto | "")
      [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]
      ;;
    *) die "BOOF_RUNNER_SKIP_DESKTOP must be 0 or 1" ;;
  esac
}

# Save uncommitted work (tracked diff and untracked files) before a forced reset.
backup_local_changes() {
  local dir="$1" backups stamp
  backups="$(dirname "$dir")/backups"
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backups"
  git -C "$dir" diff --binary HEAD >"$backups/$stamp.patch"
  log "Saved local changes to $backups/$stamp.patch"
  if [[ -n "$(git -C "$dir" ls-files --others --exclude-standard)" ]]; then
    git -C "$dir" ls-files --others --exclude-standard -z |
      (cd "$dir" && tar --null -T - -czf "$backups/$stamp-untracked.tar.gz")
    log "Saved untracked files to $backups/$stamp-untracked.tar.gz"
  fi
}

checkout_branch_if_requested() {
  local dir="$1"
  [[ -n "$BRANCH" ]] || return 0
  log "Checking out $BRANCH"
  git -C "$dir" checkout "$BRANCH"
}

update_checkout() {
  local dir="$1"
  [[ "$SKIP_UPDATE" == "1" ]] && {
    log "Skipping git update"
    return 0
  }

  if [[ "$FORCE_UPDATE" == "1" && -n "$(git -C "$dir" status --porcelain)" ]]; then
    # Tracked changes or untracked (not ignored) files: either can block the
    # fast-forward. Save both, then reset and remove the untracked files.
    # Ignored paths (data/, node_modules/, dist/) are never touched.
    backup_local_changes "$dir"
    git -C "$dir" reset --hard HEAD
    git -C "$dir" clean -fd
  elif tracked_changes_exist "$dir"; then
    die "uncommitted changes exist in $dir; nothing was changed.
Commit or stash them (git -C $dir stash), or run with BOOF_RUNNER_SKIP_UPDATE=1 to build as is,
or BOOF_RUNNER_FORCE_UPDATE=1 to save them to a backup patch and reset to the latest source."
  fi

  log "Fetching latest source"
  git -C "$dir" fetch --prune origin
  checkout_branch_if_requested "$dir"

  local upstream
  upstream="$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -n "$upstream" ]]; then
    log "Fast-forwarding from $upstream"
    git -C "$dir" pull --ff-only
  else
    log "No upstream configured; leaving current branch at fetched state"
  fi
}

source_dir() {
  local root=""
  root="$(script_checkout_root || true)"
  if [[ -n "$root" ]] && is_boof_runner_checkout "$root"; then
    printf '%s\n' "$root"
    return 0
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    printf '%s\n' "$INSTALL_DIR"
    return 0
  fi

  if [[ -e "$INSTALL_DIR" ]]; then
    die "$INSTALL_DIR exists but is not a git checkout"
  fi

  log "Cloning $REPO_URL into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
  printf '%s\n' "$INSTALL_DIR"
}

install_dependencies() {
  local dir="$1"
  if skip_desktop; then
    log "Skipping the desktop app (no Electron download); set BOOF_RUNNER_SKIP_DESKTOP=0 to include it"
    export ELECTRON_SKIP_BINARY_DOWNLOAD=1
  fi
  if command -v bun >/dev/null 2>&1; then
    log "Installing dependencies with bun"
    # Frozen: never rewrite bun.lock, so the checkout stays clean for the next update.
    (cd "$dir" && bun install --frozen-lockfile)
  else
    log "Installing dependencies with npm"
    # npm (no bun): package-lock.json is git-ignored, so the checkout stays clean for the next update.
    (cd "$dir" && npm install --no-audit --no-fund)
  fi
}

build_app() {
  local dir="$1"
  if skip_desktop; then
    log "Building web UI and CLI"
    (cd "$dir" && npm run build:server)
  else
    log "Building web UI, CLI and desktop app"
    (cd "$dir" && npm run build)
  fi
}

install_command() {
  local dir="$1"
  case "$INSTALL_MODE" in
    link)
      log "Linking boof-runner globally"
      (cd "$dir" && npm link)
      ;;
    copy)
      log "Installing boof-runner globally"
      # npm 7+ symlinks a directory install, so the CLI's external dependencies resolve from $dir.
      npm install -g "$dir"
      ;;
    *)
      die "BOOF_RUNNER_INSTALL_MODE must be 'link' or 'copy'"
      ;;
  esac
}

verify_install() {
  command -v boof-runner >/dev/null 2>&1 || die "boof-runner is not on PATH after install"
  log "Installed boof-runner $(boof-runner --version)"
  log "Command path: $(command -v boof-runner)"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  need_cmd git
  need_cmd npm
  # Before source_dir too: is_boof_runner_checkout runs node.
  need_cmd node

  local dir
  dir="$(source_dir)"
  is_boof_runner_checkout "$dir" || die "$dir is not a boof-runner checkout"
  check_node "$dir"

  update_checkout "$dir"
  install_dependencies "$dir"
  build_app "$dir"
  install_command "$dir"
  verify_install
}

# Run main only when executed, not when sourced (the tests source the functions). A script piped
# to bash has no BASH_SOURCE[0], so it still runs.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
