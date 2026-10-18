# Validation record — 2026-10-18

This is a working prototype and implementation foundation. Real home control, camera history and dot voice integration remain unfinished at the gates below. The [environment summary](environment.md) records portable toolchain evidence without raw local diagnostics.

| Validation | Observed outcome |
| --- | --- |
| Strict TypeScript build | PASS, TypeScript 7.0.2 |
| `npm test` | **93 passed, 0 failed**, approximately 2.9 seconds; [raw results](test-results.txt) |
| Swift Foundation tests | **16 passed, 0 failed**: 15 core tests plus an interactive open-stdin transport regression |
| Official MCP SDK STDIO smoke | PASS, six read-only tools, two synthetic accessories, two synthetic camera events, unallowlisted read denied; [evidence](mcp-smoke.json) |
| TypeScript → Swift interactive smoke | PASS, status/list/read with stdin kept open, synthetic 21.5°C reading; [evidence](swift-smoke.json) |
| Final Catalyst compiler build | PASS; `vtool` identifies `MACCATALYST`, minimum 17.0, SDK 27.0 |
| Xcode project | Project/scheme recognized; unsigned `CODE_SIGNING_ALLOWED=NO` build succeeded. Final compiler artifact includes subsequent bounded-config/UI hardening; a real signed build must rebuild sources. |
| Native signing | No valid signing identity. Compiler artifact is ad-hoc/linker-signed, has no Team/provisioning, and was never launched. |
| Compose configuration | PASS: default and opt-in host configuration parsed |
| Docker smoke/image execution | **BLOCKED**: Docker engine socket absent. Smoke exits 2 with `DOCKER_ENGINE_UNAVAILABLE`; no image/container started. |
| Container image digest | Pending registry access; exact Node release tag specified, no digest invented |
| Local HTTPS handler/client policy | Pure tests pass, including authentication-before-read, fixed read commands, strict input limits, TLS configuration/argument checks and safe credential-file handling |
| Real TLS / Docker-to-Mac route | **NOT TESTED**: no TLS credentials created and no listener started; engine also unavailable |
| Host hardware / cameras | **NOT TESTED**: no `HMHomeManager` construction, HomeKit authorization, accessory discovery or live camera access |
| Encrypted storage, NAS and Drive | Pure retention/recovery plans tested; no recorder, encryption executor, disk allocation, deletion, mount or upload |
| Dot cloud / voice | **NOT CONNECTED OR VERIFIED**; no connector/tunnel/key/client installation |

The TypeScript suite includes allowlist and UUID-casing enforcement, unsafe-service/scalar filtering, actual MCP initialization/tool calls, process framing/limits/timeouts/TERM-to-KILL cleanup, environment-secret exclusion, freshness/clock skew/consent checks, camera-history unavailable behavior, 30 retention/recovery cases, nine future connector-policy cases and 14 local host-handler cases.

The interactive Swift test initially failed: Foundation's `read(upToCount:)` waited for more input/EOF. The fixed transport uses partial `Darwin.read` with interrupted-read retry. A regression now proves two replies arrive while stdin remains open; the TypeScript smoke confirms the same cross-language behavior. Native tests also cover 65,536/65,537-byte config boundaries, regular-file requirements and nonblocking special-file rejection.

All fixtures are synthetic. No topology, camera image, clip, person, token, TLS key or household file was transmitted to a third party for testing. The only dependency fetch was the approved public npm package download. No physical action or HomeKit write API is implemented.

Generated native compiler/index caches were removed after builds, preserving compile-only app products and synthetic fixture/test binaries in the local validation environment. No media cache was allocated. Future builds regenerate compiler caches. Existing projects, Docker images and client configurations were not cleaned or altered.

## Exact remaining blockers

| Action / target | Status | Reason and next user action |
| --- | --- | --- |
| Development signing / native Catalyst app | Pending user action, not attempted | Select an authorized Apple Team/App ID and HomeKit provisioning in Xcode; no provisioned signing identity was available for validation. No enrollment, certificate creation, paid service or terms accepted. |
| HomeKit authorization / configured home | Pending user action, not attempted | After signing and explicit approval, select the config in the app, enable the session and personally handle Apple's privacy prompt. Then approve only chosen UUID reads. |
| Docker build/runtime / local Docker engine | Unavailable, not denied | Engine socket does not exist. User starts their already configured engine when ready; then check disk/build-cache impact and run bounded mock image/smoke. |
| HTTPS host route / Docker Desktop ↔ Mac | Pending approval and runtime proof | User-supplied TLS/token files and explicit gateway/native launch approval; validate only synthetic data first. Never broaden loopback or disable TLS. |
| Historical HSV/iCloud search / Apple's public API | Platform feasibility blocker | No supported public history catalogue/download API found. Existing iCloud history cannot be recovered by this cache design. |
| Prospective camera cache / public camera export | Pending separate feasibility/permission | Prove a supported media-export path with an approved camera before recording. Then select exact retention, reserves, quotas, encryption/key recovery and eviction policy. NAS/Drive access remains separately gated. |
| Dot voice / approved private connector | Pending capability/access proof | Check account/workspace route, approve private connector/auth and data sharing, then observe a synthetic call from the actual voice surface. Local STDIO smoke is not that proof. |

No listed action was rejected by automatic approval review. The remaining operations are unattempted pending steps, unavailable runtime facilities, or documented platform feasibility gaps. No uncertain real-world mutation remains outstanding.
