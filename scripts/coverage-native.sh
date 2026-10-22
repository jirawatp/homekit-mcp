#!/bin/bash
# Foundation-only coverage gate for native/Sources/BridgeCore. Synthetic and build-only:
# runs the SwiftPM unit tests, never launches the Catalyst app, HomeKit or any device.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
# Both stages below share one set of scratch/cache/module-cache settings (see native-env.sh).
# shellcheck source=native-env.sh
source "$project_dir/scripts/native-env.sh"

# Freshness marker, created inside this project's own build directory before the test run. Nothing is
# deleted: the report that the gate reads must be at least as new as this marker, so a coverage JSON left
# by an earlier build can never be judged in place of this run's output.
marker="$(mktemp "$build_dir/.coverage-run.XXXXXX")"
trap 'rm -f "$marker"' EXIT

native_swift_test --enable-code-coverage
codecov_json="$(native_swift_test --show-codecov-path)"
[ -f "$codecov_json" ] || { echo "Native coverage JSON was not produced at the reported path." >&2; exit 2; }
if [ "$marker" -nt "$codecov_json" ]; then
  echo "Native coverage JSON is older than this run (stale report from an earlier build); refusing to gate on it." >&2
  exit 2
fi
node "$project_dir/scripts/native-coverage-check.mjs" "$codecov_json"
