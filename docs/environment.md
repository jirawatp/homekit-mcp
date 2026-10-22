# Validated environment and portability

The toolchain rows below were recorded on 18 October 2026 unless a row says otherwise; they were **not** re-queried on 21 October 2026. This portable summary excludes local account paths, disk measurements and household configuration.

| Component | Evidence date | Validation evidence and scope |
| --- | --- | --- |
| Host platform | 2026-10-18 | macOS 27.0.1 on Apple silicon (not re-queried 2026-10-21) |
| Native toolchain | 2026-10-18; Swift 6.4 toolchain used again 2026-10-21 and 2026-10-22 | Full Xcode, macOS SDK 27.0, Apple Swift 6.4; the later Swift tests and compile-only builds ran on this toolchain |
| HomeKit target | 2026-10-18 | Mac Catalyst; public headers mark `HMHomeManager` unavailable for native macOS and available for Mac Catalyst (header inspection not repeated) |
| Native deployment target | 2026-10-18 | Mac Catalyst 17.0 / macOS 14; older-runtime execution has not been tested |
| JavaScript runtime requirement | 2026-10-21 | Node 22.19 or later, as declared in `package.json`; the 2026-10-21 and 2026-10-22 tests ran on Node 22.19.0; no other Node version was tested |
| TypeScript compiler | 2026-10-21 | Pinned TypeScript 7.0.2 (used for the 2026-10-21 builds) |
| Coverage tool | 2026-10-21 | Pinned `c8` 12.0.0 (development dependency) |
| Native signing | 2026-10-18; unchanged 2026-10-21 | Compile-only artifacts have no development Team/HomeKit provisioning and were never launched; no signing was attempted on 2026-10-21 |
| Docker client | 2026-10-18 only | Docker 29.0.1 (darwin/arm64), Compose v2.40.3-desktop.1 (not re-queried; Compose configuration not re-parsed 2026-10-21) |
| Docker engine | 2026-10-18 only | Unavailable during validation; image build, container runtime and host TLS routing remain unverified. No engine was started on 2026-10-21. |

Public HomeKit access on Mac requires a **Mac Catalyst app**, appropriate signing/provisioning and user HomeKit consent. A Linux container cannot load the Apple framework or inherit that permission. No live device or camera test has run. See [native setup](native-setup.md), [Docker setup](docker.md) and the [validation record](validation.md).

Paths in setup commands are placeholders. Replace `/absolute/path/to/project` with the local checkout path; never commit the expanded local path, signing assets, HomeKit allowlists or credential files. Diagnostic output may contain local paths and free-space information; keep raw local diagnostics outside public version control.

The results recorded in the 2026-10-22 consolidated run are **146 TypeScript tests and 82 Swift Foundation tests passing** (the 2026-10-21 figure of 20 Swift tests predates the transport/lifecycle hardening), plus synthetic MCP and TypeScript-to-Swift smoke checks and an unsigned compile-only Catalyst build. They establish tested code/protocol behavior, not HomeKit authorization, actual device access, camera export, encrypted storage durability, Docker execution or dot voice integration.
