#!/usr/bin/env bash
# Vendor the headless-crew CI gate workflow + scripts into the current repo.
# Run from the client repo root, with a checkout of iamwatney/watney-shared
# at a known path (default: ../watney-shared, override with WATNEY_SHARED_DIR).
set -euo pipefail

WATNEY_SHARED_DIR="${WATNEY_SHARED_DIR:-../watney-shared}"

if [ ! -d "$WATNEY_SHARED_DIR/ci-gates" ]; then
  echo "ERROR: $WATNEY_SHARED_DIR/ci-gates not found. Set WATNEY_SHARED_DIR or clone iamwatney/watney-shared next door." >&2
  exit 1
fi

mkdir -p .github/workflows .github/scripts

cp "$WATNEY_SHARED_DIR/ci-gates/workflows/headless-crew-ci-gate.yml" .github/workflows/
cp "$WATNEY_SHARED_DIR/ci-gates/scripts/qc-rls-gate-file.js"        .github/scripts/
cp "$WATNEY_SHARED_DIR/ci-gates/scripts/qc-shared-lib-gate-ci.js"   .github/scripts/

echo "Vendored:"
echo "  .github/workflows/headless-crew-ci-gate.yml"
echo "  .github/scripts/qc-rls-gate-file.js"
echo "  .github/scripts/qc-shared-lib-gate-ci.js"
echo
echo "Commit, push, open a synthetic PR to verify the 'headless-crew-ci-gate / gate' status check appears."
