#!/usr/bin/env bash
set -Eeuo pipefail

IFS=$'\n\t'

APP_NAME="boof-runner"
DEFAULT_REPO="git@github.com:YaminT/boof-runner.git"
DEFAULT_DIR="${XDG_DATA_HOME:-"$HOME/.local/share"}/boof-runner/source"

REPO_URL="${BOOF_RUNNER_REPO:-$DEFAULT_REPO}"
INSTALL_DIR="${BOOF_RUNNER_DIR:-$DEFAULT_DIR}"
BRANCH="${BOOF_RUNNER_BRANCH:-}"
SKIP_UPDATE="${BOOF_RUNNER_SKIP_UPDATE:-0}"
INSTALL_MODE="${BOOF_RUNNER_INSTALL_MODE:-link}"

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
  BOOF_RUNNER_INSTALL_MODE  link or copy. Default: link.

Examples:
  ./scripts/install-or-update-boof-runner.sh
  BOOF_RUNNER_BRANCH=main bash scripts/install-or-update-boof-runner.sh
  BOOF_RUNNER_REPO=https://github.com/YaminT/boof-runner.git bash scripts/install-or-update-boof-runner.sh
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

check_node() {
  need_cmd node
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  [[ "$major" -ge 20 ]] || die "Node.js >= 20 is required; found $(node --version)"
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

  tracked_changes_exist "$dir" &&
    die "tracked local changes exist in $dir; commit/stash them or run with BOOF_RUNNER_SKIP_UPDATE=1"

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
  if command -v bun >/dev/null 2>&1; then
    log "Installing dependencies with bun"
    (cd "$dir" && bun install)
  else
    log "Installing dependencies with npm"
    (cd "$dir" && npm install)
  fi
}

build_app() {
  local dir="$1"
  log "Building web UI and CLI"
  (cd "$dir" && npm run build)
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
      npm install -g "$dir"
      ;;
    *)
      die "BOOF_RUNNER_INSTALL_MODE must be 'link' or 'copy'"
      ;;
  esac
}

verify_install() {
  command -v boof-runner >/dev/null 2>&1 || die "boof-runner is not on PATH after install"
  log "Installed $(boof-runner --help | sed -n '1p')"
  log "Command path: $(command -v boof-runner)"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  need_cmd git
  need_cmd npm
  check_node

  local dir
  dir="$(source_dir)"
  is_boof_runner_checkout "$dir" || die "$dir is not a boof-runner checkout"

  update_checkout "$dir"
  install_dependencies "$dir"
  build_app "$dir"
  install_command "$dir"
  verify_install
}

main "$@"
