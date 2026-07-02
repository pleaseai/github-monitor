#!/usr/bin/env bash
# One-time local bootstrap publish of the github-monitor npm packages.
# Usage:  bash scripts/publish-npm-bootstrap.sh <OTP>
# Run this the moment you read a fresh code from your authenticator, since npm
# OTPs expire in ~30s. Platform packages publish first, then the wrapper (whose
# optionalDependencies pin them). Already-published versions are skipped.
set -uo pipefail

OTP="${1:-}"
if [ -z "$OTP" ]; then
  echo "usage: bash scripts/publish-npm-bootstrap.sh <OTP>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/npm/dist"
if [ ! -d "$DIST/github-monitor" ]; then
  echo "error: $DIST not generated. Run the generator first." >&2
  exit 1
fi

publish() {
  local dir="$1" name
  name=$(node -e "process.stdout.write(require('$dir/package.json').name+'@'+require('$dir/package.json').version)")
  if npm view "$name" version >/dev/null 2>&1; then
    echo "skip (already published): $name"
    return 0
  fi
  echo "publishing: $name"
  npm publish "$dir" --access public --otp "$OTP" || return 1
}

fail=0
# Platform packages first.
for dir in "$DIST"/@pleaseai__*; do
  publish "$dir" || fail=1
done
# Wrapper last.
publish "$DIST/github-monitor" || fail=1

if [ "$fail" -ne 0 ]; then
  echo "SOME PUBLISHES FAILED — re-run with a FRESH OTP; already-published ones are skipped." >&2
  exit 1
fi
echo "ALL PUBLISHED."
