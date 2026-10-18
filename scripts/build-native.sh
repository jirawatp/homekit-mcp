#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
native_dir="$project_dir/native"
build_dir="$native_dir/build"
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
support_dir="$sdk_path/System/iOSSupport"
architecture="$(uname -m)"
app_dir="$build_dir/HomeKitMCPBridge.app"

if [ ! -d "$support_dir/System/Library/Frameworks/HomeKit.framework" ]; then
  echo "Public Mac Catalyst HomeKit SDK is missing. Install full Xcode." >&2
  exit 1
fi
mkdir -p "$app_dir/Contents/MacOS" "$build_dir/module-cache"
cp "$native_dir/Resources/Info.plist" "$app_dir/Contents/Info.plist"
xcrun swiftc -swift-version 5 -O -parse-as-library \
  -target "$architecture-apple-ios17.0-macabi" -sdk "$sdk_path" \
  -I "$support_dir/usr/include" -F "$support_dir/System/Library/Frameworks" \
  -L "$support_dir/usr/lib" -module-cache-path "$build_dir/module-cache" \
  -framework UIKit -framework HomeKit -framework Foundation \
  "$native_dir"/Sources/BridgeCore/*.swift "$native_dir"/Sources/Helper/*.swift \
  -o "$app_dir/Contents/MacOS/HomeKitMCPBridge"

echo "Built Mac Catalyst app: $app_dir"
echo "Compile-only development artifact. Not provisioned for HomeKit and not launched."
echo "See native/README.md for user-controlled Xcode signing and HomeKit authorization."
