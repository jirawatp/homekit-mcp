# Native HomeKit setup

## Verified environment and supported architecture

Validated toolchain on 2026-10-18; see the portable [environment summary](environment.md):

| Check | Result |
| --- | --- |
| Operating system | macOS 27.0.1, Apple silicon |
| Swift | Apple Swift 6.4 |
| macOS SDK | 27.0 |
| Public HomeKit SDK | `MacOSX.sdk/System/iOSSupport/System/Library/Frameworks/HomeKit.framework` |
| Native macOS HomeKit SDK | No public framework module in `MacOSX.sdk/System/Library/Frameworks` |
| Signing | No development-signing identity or HomeKit provisioning used for validation |

Apple's [HomeKit documentation](https://developer.apple.com/documentation/homekit) lists Mac Catalyst 14.0+. The installed `HMHomeManager.h` explicitly marks the class `API_UNAVAILABLE(macos)` and `API_AVAILABLE(macCatalyst(14.0))`. A runtime framework's presence in `/System/Library` does not establish a supported native macOS API. This project therefore uses a **Mac Catalyst app running locally on macOS**, rather than private APIs or platform-availability overrides. This project's deployment target is iOS 17 Mac Catalyst / macOS 14; only the toolchain in the environment summary has been verified.

The MCP TypeScript process spawns the app executable with private inherited stdin/stdout pipes. There is no TCP listener, cloud endpoint, login item, launch agent, bookmark, or background service in this native transport. Dot cloud cannot directly reach these local pipes. A compatible **local** MCP client must run the server on the Mac hosting the bridge.

## What has been tested

`bash scripts/build-native.sh` compiles an arm64 Mac Catalyst `.app` at:

```
native/build/HomeKitMCPBridge.app
```

This is a compile-only development artifact. It is not provisioned for HomeKit and has not been launched. Three different builds are recorded and must not be conflated. (1) `build-native.sh` compiles the sources with `swiftc` and does **not** exercise the Xcode project. (2) An unsigned build of the included Xcode project succeeded on 2026-10-18; that is historical, because the project has changed since (`SessionCoordinator.swift` was added). (3) On 2026-10-22 the operator ran a fresh signing-disabled Debug build of the current `HomeKitMCPBridge.xcodeproj` and shared scheme, in a scratch copy containing only the project, resources and Swift sources, for the generic Mac Catalyst destination with `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO`, an empty signing identity and an empty development team, and it passed. The log shows `App.swift`, `HomeKitController.swift`, `BridgeCore.swift`, `SessionCoordinator.swift` and `StdioServer.swift` compiled for both arm64 and x86_64 and linked into a universal Mac Catalyst app (static inspection: `MACCATALYST`, minimum 17.0, SDK 27.0 for both). That confirms project compilation and linkage only: the app was not launched, no `HMHomeManager` was created, no HomeKit consent was requested, and no device was contacted. `bash scripts/test-native.sh` runs the Foundation-only SwiftPM tests (the authoritative count and coverage are recorded in [validation](validation.md) after each consolidated run; this page deliberately carries no count), including subprocess transport regressions that require two responses while stdin remains open and a bridge exit when the response pipe breaks, in-process transport tests with injected input/output/encoder/timeouts (exactly-once settlement, late/duplicate callbacks, fail-closed encoding and write errors), and pure session-lifecycle tests (enable/disable/reload/revocation/session-change/refresh timeout). It also builds `native/.build/debug/BridgeFixture`, whose only data is synthetic. Configuration tests cover the 64 KiB boundary, oversized/truncated JSON, and nonregular files including a FIFO. The TypeScript-to-Swift interactive fixture also checks status/list/read and allowlist denial. No real `HMHomeManager` has been initialized during development, no HomeKit prompt has been accepted, and no real home/device data has been read.

The linker automatically embeds an **ad-hoc linker signature**. Read-only `codesign` inspection of the compiler-built app (and of the 2026-10-22 Xcode project build) reports an `adhoc`, linker-signed Mach-O signature, `TeamIdentifier=not set`, no sealed resources and an unbound Info.plist. The 2026-10-22 project build ran **zero CodeSign build phases** and produced no `_CodeSignature` directory, so it is a signing-disabled compile, not a development- or distribution-signed app. It is not a HomeKit provisioning profile or proof of entitlement/permission, and signing-dependent entitlements were not exercised. No signing identity, certificate, provisioning or account configuration was created or used.

## User-controlled signing

**Validation blocker:** no development-signing identity or HomeKit provisioning was available. A deployment requires an authorized signing identity, a HomeKit-enabled App ID, matching provisioning, an Apple Home setup and HomeKit privacy approval. None has been created, enabled, purchased, or changed by this project.

The included `native/HomeKitMCPBridge.xcodeproj` is a minimal Catalyst app project. When ready, the user can:

1. Open the Xcode project and select the `HomeKitMCPBridge` target.
2. In **Signing & Capabilities**, choose their own Apple development Team and a unique bundle identifier. Signing in, creating certificates/App IDs/profiles, accepting agreements, or enabling account features are user actions. This project does not automate them.
3. Enable/verify the **HomeKit** capability on the target and App ID. The source entitlements include `com.apple.developer.homekit`. Xcode may need a matching provisioning profile from the selected Team. If the chosen account cannot provision HomeKit, resolve that account/capability limitation with Apple; ad-hoc signing does not establish HomeKit authorization.
4. Retain the app sandbox, outbound network client, and user-selected read-only file entitlements in `Resources/HomeKitMCPBridge.entitlements`. These allow HomeKit communication and a user-selected configuration file without opening a server.
5. Select **My Mac (Mac Catalyst)** and **Product → Build**. Building does not require starting HomeKit. Find the built app using the Products group, then **Show in Finder**.
6. Point the local MCP server's native executable setting at that built `.app/Contents/MacOS/HomeKitMCPBridge`. Keep the project build and executable path together. Do not add `--enable` or an authorization command; none exists.

For a build without signing, the compiler script is sufficient. The Xcode equivalent (a simplified form of the signing-disabled project build verified on 2026-10-22, which also cleared the signing identity and development team and kept its derived data and module cache inside a scratch directory) is:

```sh
xcodebuild -project native/HomeKitMCPBridge.xcodeproj \
  -scheme HomeKitMCPBridge -configuration Debug \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath native/build/xcode CODE_SIGNING_ALLOWED=NO build
```

HomeKit availability through this signed app still needs a real device test after the user completes setup. Neither the compiler build nor the signing-disabled Xcode project build is evidence that signing, entitlement, privacy authorization or HomeKit database access works.

## User-controlled access and allowlist

Apple explains that [creating `HMHomeManager` typically triggers its permission dialog](https://developer.apple.com/documentation/homekit/enabling-homekit-in-your-app). The helper never constructs it at launch or in response to MCP input.

After signing and choosing to begin a real test:

First copy the deny-all `config/homekit.example.json` to ignored `config/homekit.local.json`. Keep actual accessory UUIDs and expanded local paths in private configuration only. The prepared native snippet uses this local filename; regenerate it with `node scripts/client-config.mjs --native` or replace the committed template's placeholders locally. Do not commit the resulting private snippet.

1. Start the native MCP profile from a local client. It supplies `--stdio --config /absolute/path/to/project/config/homekit.local.json`; the helper opens visibly with access disabled.
2. Click **Choose allowlist JSON file…** and choose that same `config/homekit.local.json` file. The sandbox may initially reject the command-line file path. The standard picker grants read-only access for this process only; no persistent security-scoped bookmark is stored. Until the file is readable and valid, the helper denies every accessory.
3. Click **Enable HomeKit access for this session…**, review the app's confirmation, then personally handle Apple's HomeKit permission dialog. Do not approve it until ready to share the selected state with the chosen MCP client/model.
4. After authorization, the app displays noncamera accessory names and UUIDs **only in its foreground local UI**. Copy only the desired accessory UUIDs into `allowedAccessoryIds` in the configuration file. Keep `version: 1` and `mode: "read-only"`. An empty list denies every accessory; wildcard/duplicate/invalid UUIDs are rejected.
5. Click **Reload explicit accessory allowlist**. Failed reloads revoke the old allowlist immediately. The TypeScript layer separately caches its loaded allowlist, so also **restart the local MCP profile** after config changes. Choose the same configuration file and enable the newly launched helper session again. Both layers must load the same updated configuration.
6. Use `status`, then list/read the specifically allowed sensor. **Disable this session** releases the home manager and clears cached values. Closing the inherited pipe exits the app. Every app launch requires the enable action again. Apple retains its own privacy decision until revoked in System Settings; the app does not alter that system decision on disable.

The HomeKit entitlement itself is not read-only: Apple's API permits control when authorized. This implementation provides the read-only boundary by exposing no writes, scenes, automations, subscriptions, accessory identification, lock/garage commands, or camera operations. HomeKit topology may enter Apple's framework after approval; only allowlisted, filtered fields can leave the helper through stdio. An enabled external MCP client can relay returned fields to its model service, so choose the client and accessory scope deliberately.

## Data and protocol

Requests and responses are one JSON object per line, with a maximum 64 KiB request frame. Only one request is processed at a time. Invalid input receives a generic error, without raw HomeKit error details or home data in logs.

```json
{"id":"request-1","command":"status"}
{"id":"request-2","command":"list_accessories"}
{"id":"request-3","command":"read_accessory","accessoryId":"11111111-1111-4111-8111-111111111111"}
```

The response is `{ "id": "...", "ok": true, "result": ... }` or `{ "id": "...", "ok": false, "error": { "code": "...", "message": "..." } }`. There is no permission/start/control command. `status` works without initializing HomeKit. Discovery/read commands require the user-enabled session, authorized HomeKit, and the initial home-manager delegate update. Read requests are checked against the allowlist before accessing characteristics, and again after asynchronous reads.

Transport behavior: each request ends in exactly one response, or one `bridge_timeout` error followed by closing the transport (30 seconds per request). Only the transport loop writes, so a handler that replies twice, or replies after the timeout, cannot produce output. If a response cannot be encoded or written (for example the reader of the pipe is gone) the bridge stops dispatching, attempts no further writes, and closes once; the Catalyst app then disables the session and exits.

Response ceiling and write loop: one response frame (the encoded JSON plus its newline) may be at most 1,048,576 bytes, the same limit the TypeScript client applies to its input buffer. The size is checked on the encoded bytes immediately before the write, so no larger frame is ever emitted. An oversize response is replaced by a small `{"ok":false,"error":{"code":"response_too_large",...}}` reply with the same request id (the TypeScript side reports it as a generic native failure) and the session continues; the message carries no size or content. If even that replacement cannot be encoded within the limit or cannot be written, the bridge fails closed as above. **Limit of this control:** it bounds what is emitted, not the transient memory used to encode a response; that is bounded only indirectly by the at-most-256 allowlisted accessories and the safe-scalar filters, and the native layer does not otherwise cap service or characteristic counts or name lengths. The write loop continues after short writes, retries `EINTR`, and treats a zero-byte write or any other error as a failure (it never spins); this is tested with an injected write function, not by exhausting a real pipe. The session lifecycle rules (generation bump on enable, disable, reload, home update and revocation; a read is accepted into the cache only if its session is unchanged, enabled, authorized and allowlisted; each batch of characteristic reads completes exactly once, from the last read or the five-second deadline) live in Foundation-only `SessionCoordinator.swift` and are unit-tested. HomeKit objects, delegates, the authorization status mapping and the consent UI stay in `native/Sources/Helper` and are **not** covered by those tests.

The only characteristic UUID stems permitted are `11` temperature, `10` humidity, `71` occupancy, `22` motion, `6A` contact, `68` battery, `76` smoke, `69` carbon monoxide, `70` leak, `6B` ambient light, `95` air quality, `75` active status, and `25` power. Each uses Apple's `000000XX-0000-1000-8000-0026BB765291` UUID form. Only Boolean and finite numeric values are returned. Binary/TLV, strings, vendor characteristics, pairing material, locks, garages, camera/microphone/speaker/doorbell services, and whole camera-profile accessories are excluded. Both native and TypeScript layers exclude service UUID stems `40`, `41`, `44`, `7E`, `110`, `111`, `112`, `113`, `121`, and `129` as defense in depth.

`list_accessories` returns filtered topology and previously successful cached observations only. It does not claim cached values were freshly read. `read_accessory` uses Apple's read API for the safe fields, clears old values before refresh, and bounds the refresh to five seconds. A failed/timed-out value is absent. A returned value's `observedAt` is its successful read time; an accessory-level timestamp describes the topology snapshot. `roomId` is a stable HomeKit room UUID for allowlisted accessories; it does not enumerate other rooms.

## Camera history boundary

The macOS 27 SDK's public `HMCameraProfile.h` exposes stream, snapshot, settings, microphone, and speaker controls. `HMCameraSnapshotControl.h` exposes taking a snapshot and the most recent snapshot; `HMCameraStreamControl.h` exposes stream start/stop. Searching the public HomeKit headers found no recording/history/clip/iCloud video retrieval API. These observations support the current conclusion that public HomeKit camera APIs do **not provide this project's requested historical HSV/iCloud clip search**; a live stream or snapshot API must not be described as historical access.

No camera API is invoked or implemented here. A future local recording/cache design would require separate explicit permission, a camera allowlist, retention and disk limits, encryption/deletion policy, and tests using synthetic footage first. It would record only future authorized observations and could not reconstruct prior iCloud recordings. No ongoing capture, camera entitlement change, or cache has been configured.
