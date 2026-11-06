#!/usr/bin/env bash
# Version facts for the release workflow: BOOF_RUNNER_APP_VERSION=<tag without v> and
# RELEASE_PRERELEASE_FLAG=--prerelease (only for a tag with a prerelease part). Refuses a tag that
# is not v<major>.<minor>.<patch>[-<pre>] or whose base version is not package.json's.
set -Eeuo pipefail
tag="${1:?usage: release-version.sh <tag> [package.json]}"
pkg="${2:-package.json}"
version="${tag#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  { echo "release-version: tag '$tag' is not v<major>.<minor>.<patch>[-<prerelease>]" >&2; exit 1; }
base="${version%%-*}"
pkg_version="$(node -p 'require(require("node:path").resolve(process.argv[1])).version' "$pkg")"
[[ "$base" == "$pkg_version" ]] ||
  { echo "release-version: tag $tag does not match package.json version $pkg_version" >&2; exit 1; }
prerelease=""
[[ "$version" == *-* ]] && prerelease="--prerelease"
printf 'BOOF_RUNNER_APP_VERSION=%s\nRELEASE_PRERELEASE_FLAG=%s\n' "$version" "$prerelease"
