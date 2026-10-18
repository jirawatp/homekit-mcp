# Validated environment and portability

The prototype was validated on 18 October 2026 with the following toolchain. This portable summary excludes local account paths, disk measurements and household configuration.

| Component | Validation evidence and scope |
| --- | --- |
| Host platform | macOS 27.0.1 on Apple silicon |
| Native toolchain | Full Xcode, macOS SDK 27.0, Apple Swift 6.4 |
| HomeKit target | Mac Catalyst; public headers mark `HMHomeManager` unavailable for native macOS and available for Mac Catalyst |
| Native deployment target | Mac Catalyst 17.0 / macOS 14; older-runtime execution has not been tested |
| JavaScript runtime requirement | Node 22.19 or later, as declared in `package.json` |
| TypeScript compiler | Pinned TypeScript 7.0.2 |
| Native signing | Compile-only artifacts have no development Team/HomeKit provisioning and were never launched |
| Docker client | Docker 29.0.1 (darwin/arm64), Compose v2.40.3-desktop.1 |
| Docker engine | Unavailable during validation; image build, container runtime and host TLS routing remain unverified |

Public HomeKit access on Mac requires a **Mac Catalyst app**, appropriate signing/provisioning and user HomeKit consent. A Linux container cannot load the Apple framework or inherit that permission. No live device or camera test has run. See [native setup](native-setup.md), [Docker setup](docker.md) and the [validation record](validation.md).

Paths in setup commands are placeholders. Replace `/absolute/path/to/project` with the local checkout path; never commit the expanded local path, signing assets, HomeKit allowlists or credential files. Diagnostic output may contain local paths and free-space information; keep raw local diagnostics outside public version control.

The recorded results are **93 TypeScript tests and 16 Foundation/Swift tests passing**, plus synthetic MCP and TypeScript-to-Swift smoke checks. They establish tested code/protocol behavior, not HomeKit authorization, actual device access, camera export, encrypted storage durability, Docker execution or dot voice integration.
