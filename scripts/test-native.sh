#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=native-env.sh
source "$project_dir/scripts/native-env.sh"
native_swift_test "$@"
