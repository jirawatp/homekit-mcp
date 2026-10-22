# Native bridge

This original Swift helper uses Apple's public **Mac Catalyst** HomeKit framework. The pure Foundation package contains the protocol, allowlist policy, framing, tests, and a synthetic fixture. `Sources/Helper` contains the UIKit app and the sole, user-triggered `HMHomeManager` initialization.

See [native setup](../docs/native-setup.md) for the platform evidence, signing steps, permissions, protocol, and current limitations.

From the project root:

```sh
bash scripts/build-native.sh
bash scripts/test-native.sh
```

The build script compiles the app without provisioning and never launches it. Tests and `BridgeFixture` cannot import HomeKit. The fixture binary is `native/.build/debug/BridgeFixture`. With the Swift 6.4 toolchain used here, `.build/debug` is a symlink to `.build/out/Products/Debug`; other toolchains may place products elsewhere (for example under `.build/<triple>/debug`).
