#!/usr/bin/env bash
# Verify that every macOS .app under a directory carries a valid ad-hoc signature.
# Usage: verify-mac-codesign.sh <release-dir>
set -euo pipefail

dir="${1:?usage: verify-mac-codesign.sh <release-dir>}"
found=0
while IFS= read -r -d '' app; do
  found=$((found + 1))
  echo "Verifying $app"
  codesign --verify --deep --strict --verbose=2 "$app"
  info="$(codesign -dv "$app" 2>&1)"
  printf '%s\n' "$info"
  if ! grep -q 'Signature=adhoc' <<<"$info"; then
    echo "error: $app is not ad-hoc signed" >&2
    exit 1
  fi
done < <(find "$dir" -maxdepth 2 -name '*.app' -type d -print0)

if [ "$found" -eq 0 ]; then
  echo "error: no .app found under $dir" >&2
  exit 1
fi
echo "Verified $found app(s)"
