#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
native_dir="$project_dir/native"
build_dir="$native_dir/.build"
mkdir -p "$build_dir/module-cache" "$build_dir/cache" "$build_dir/config" "$build_dir/security"
cd "$native_dir"
CLANG_MODULE_CACHE_PATH="$build_dir/module-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$build_dir/module-cache" \
swift test --scratch-path "$build_dir" --cache-path "$build_dir/cache" \
  --config-path "$build_dir/config" --security-path "$build_dir/security" --disable-sandbox
