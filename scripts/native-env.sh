# Sourced (not executed) by test-native.sh and coverage-native.sh so that EVERY SwiftPM invocation in the
# native checks uses the same project-local scratch, cache, config, security and module-cache locations.
# This keeps restricted/sandboxed runs reproducible: nothing is written to the user-level clang or SwiftPM
# caches, and the coverage-path lookup cannot silently fall back to a non-writable global location.
# Expects `project_dir` to be set by the caller. Foundation-only SwiftPM tests; never launches the app.
native_dir="$project_dir/native"
build_dir="$native_dir/.build"
mkdir -p "$build_dir/module-cache" "$build_dir/cache" "$build_dir/config" "$build_dir/security"
export CLANG_MODULE_CACHE_PATH="$build_dir/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$build_dir/module-cache"

# Usage: native_swift_test [swift test arguments...]
native_swift_test() {
  (cd "$native_dir" && swift test --scratch-path "$build_dir" --cache-path "$build_dir/cache" \
    --config-path "$build_dir/config" --security-path "$build_dir/security" --disable-sandbox "$@")
}
