# Platform and integration research

Checked 18 October 2026 against primary documentation. This is an original implementation. Public projects below were read for architecture and licensing context; no source code was copied, installed, or rebranded. No real HomeKit authorization, camera access, recording, network exposure, credentials, or persistent client access was enabled by this research.

## Supported native route on Mac

Apple lists **Mac Catalyst 14.0+**, alongside its mobile platforms, for the public HomeKit framework. It does not list an ordinary native macOS/AppKit HomeKit API. The practical Mac bridge is therefore a UIKit **Mac Catalyst app**, containing the HomeKit-dependent code, with a local MCP process outside it. A plain Swift command-line target importing a similarly named framework is not proof that HomeKit is supported at runtime. The installed SDK/build evidence is recorded separately by the native implementation. [HomeKit framework](https://developer.apple.com/documentation/homekit)

Enable `com.apple.developer.homekit` for the app, include `NSHomeKitUsageDescription`, and use an appropriate signed App ID/provisioning profile. Apple's sample specifically instructs developers to set a valid signing team so Xcode can create a profile containing the entitlement. Apple's macOS capability table marks HomeKit for Apple Developer Program membership and leaves Developer ID and free Apple Developer columns blank. Its checkmark icons were checked in the public HTML because plain text extraction loses them. Existing developer-team access must be checked by the user; this project does not enroll, accept terms, create a certificate, or change the signing account. [Apple sample configuration](https://developer.apple.com/documentation/homekit/configuring-a-home-automation-device), [Supported capabilities (macOS)](https://developer.apple.com/help/account/reference/supported-capabilities-macos)

The first HomeKit framework access, typically constructing `HMHomeManager`, can trigger the system authorization dialog. Apple remembers the response, and the user can subsequently revoke it. Merely constructing the manager is therefore outside an authorization-free diagnostic. Real access must start only through a clearly labeled user action in the signed app. Missing permission, denied permission, unavailable data, and an empty authorized home are distinct states. No automated prompt acceptance is appropriate. [Enabling HomeKit in your app](https://developer.apple.com/documentation/homekit/enabling-homekit-in-your-app)

HomeKit's permission is broad. Our empty-by-default accessory allowlist and read-only tool surface are additional application policy, not a narrower Apple permission. They must be enforced in both the native boundary and MCP layer.

## Cameras and HomeKit Secure Video

| Capability | Public documented surface | Product conclusion |
| --- | --- | --- |
| Home/accessory/room metadata and readable characteristics | `HMHomeManager`, homes, accessories, services and characteristics | Implementable after signing and HomeKit consent; disclose only allowlisted records. |
| Snapshot request | `HMCameraProfile.snapshotControl`, `HMCameraSnapshotControl.takeSnapshot()` | API exists, but no camera access is authorized in this build session. Each profile control is optional. |
| Current live stream | `HMCameraProfile.streamControl`, `HMCameraStreamControl` | Public viewing support exists; opening a stream is a separate future authorization. |
| Historic HSV/iCloud events and recordings | No supported public third-party listing/download/search API found in the reviewed public HomeKit documentation | **Feasibility blocker.** Return an explicit unavailable capability, never an empty result implying no events. |

The public camera profile documents settings, microphone/speaker, stream control, and snapshot control. It does not document an HSV recording catalogue, historical event query, or iCloud clip-download interface. Apple's consumer documentation says HSV footage is end-to-end encrypted, analyzed by the home hub, and the last ten days can be viewed **in the Home app**. That consumer capability is not evidence of a third-party API. The conclusion above is an inference from the reviewed public API surface, not a claim that Apple could never introduce one. [HMCameraProfile](https://developer.apple.com/documentation/homekit/hmcameraprofile), [Snapshot control](https://developer.apple.com/documentation/homekit/hmcamerasnapshotcontrol), [Apple HSV guide](https://support.apple.com/en-ie/guide/icloud/mme054c72692/icloud)

There is a second export limitation: the documented `HMCameraSource` provides an aspect ratio; snapshots provide a capture date; `HMCameraView` renders a snapshot/stream source. These pages do not promise raw encoded video samples or JPEG export. A future capture spike must prove supported, reliable pixel extraction with a consented camera before promising a recorder. Rendering a camera view does not itself prove an unattended stream recorder can be built. Do not use private APIs or extract iCloud keys to fill this gap. [HMCameraSource](https://developer.apple.com/documentation/homekit/hmcamerasource), [HMCameraSnapshot](https://developer.apple.com/documentation/homekit/hmcamerasnapshot), [HMCameraView](https://developer.apple.com/documentation/homekit/hmcameraview)

The project uses one HomeKit standard layer across compatible camera brands. This design does not introduce a vendor or NVR integration dependency. A prospective private cache is a **design/evaluation** fallback; it is not existing HSV history and cannot recover footage already stored in iCloud.

## Prospective cache evaluation, not enabled capture

History would begin only after explicit capture, camera allowlist, storage location, and access authorization. The product design evaluates retention **between 7 and 30 days**, but no exact default, quota, or capture cadence is active. Any NAS destination requires its own available-capacity, protocol, durability, encryption and reservation checks. No NAS was mounted or inspected.

Evaluate these options after the public capture/export spike:

| Option | Benefit | Limit to prove |
| --- | --- | --- |
| Allowlisted snapshots at an approved cadence or sensor event | Small images and a simple event index | Sampling can miss action; camera battery, rate limits, privacy modes, export behavior, and Mac suspension affect coverage. |
| Event-window footage, if a public capture path is proven | More context with bounded space | Neither raw stream export nor a reliable pre-event buffer is established. |
| Continuous footage, only if a public capture path is proven | Most temporal coverage | Highest storage and power demand; no unattended capture guarantee. |

Planning equations use decimal GB and exclude indexes, thumbnails, encryption/filesystem overhead, replicas, and safety reserve:

```text
continuous GB/day/camera = average Mbps × 10.8
event GB/day/camera      = Mbps × seconds/event × events/day ÷ 8,000
snapshot GB/day/camera   = average JPEG bytes × (86,400 ÷ interval seconds) ÷ 1,000,000,000
required GB             = cameras × GB/day/camera × retention days + overhead + reserve
```

Illustrative assumptions, not measured camera data or selected settings:

| Per camera | Per day | 7 days | 30 days |
| --- | ---: | ---: | ---: |
| 200 kB snapshot every 60 seconds | 0.288 GB | 2.016 GB | 8.64 GB |
| 2 Mbps, 20-second event, 60 events/day | 0.300 GB | 2.100 GB | 9.00 GB |
| Continuous 2 Mbps | 21.600 GB | 151.200 GB | 648.00 GB |

Four cameras at the continuous example need 2,592 GB for 30 days before overhead. Event-triggered and snapshot estimates are substantially smaller but have different evidence coverage. Choose quota only against **measured free space**, deployment reserve, actual image sizes/bitrate, and the approved retention. No price estimate, paid service, or purchase is required for this evaluation.

To tolerate power interruption, evaluate the Mac as the HomeKit capture host with a small encrypted local spool, then encrypted-object transfer to an approved NAS destination. Use an append-only/transactional index, a durable temporary write followed by atomic rename, checksums/authenticated encryption, idempotent event IDs, bounded spool space, and startup reconciliation. Treat an unavailable NAS as unavailable storage; do not silently redirect captures or discard footage without an explicit policy. Enforce both age and byte limits, and stop ingestion when the reserved-space threshold cannot be maintained. Persist acknowledgements only after the target is durable. Reconcile orphaned files and incomplete index entries on recovery, and expose coverage gaps after restart. A UPS and controlled shutdown are optional deployment considerations; neither is configured by this project.

An event record should carry source/camera ID, room, capture time, observation time, indexing time, provider, freshness/age, availability, and coverage gaps. Anonymous occupancy can say “presence observed in the kitchen at 20:10,” with its age and source; it cannot establish who is there. Named-person room lookup would require separately consented, explicitly associated device/presence signals. No facial recognition, appearance-based identity, or person tracking is part of this project.

## MCP, dot, and voice connection boundaries

Local Codex clients support command-launched STDIO and Streamable HTTP MCP. Project-scoped `.codex/config.toml` is supported for trusted projects; the desktop app, CLI, and IDE share host configuration. Hosted ChatGPT uses installed plugins/custom MCP connections and does not read local Codex configuration. Therefore a working local STDIO smoke test is **not** a working dot integration, and cloud services cannot directly reach a local host's STDIO or loopback address. Keep this project's prepared client snippet isolated and reversible. [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)

Current official OpenAI documentation offers **Secure MCP Tunnel**: a local `tunnel-client` forwards private STDIO or HTTP MCP requests over outbound HTTPS, without inbound firewall ports. It is a candidate for a later private connection. Creating/managing requires Platform Tunnels Read + Manage; using requires Read + Use. It must be associated with the intended ChatGPT workspace/Platform organization, and custom MCP access remains separately permission-controlled. Setup needs approved credentials and ongoing local process access. No tunnel, key, plugin, or service was created. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

ChatGPT's custom MCP workflow accepts public HTTPS or a selected tunnel, with authentication and a risk/consent step. For this project, prefer the private route if it is available to the user's account. Transport access is not household authorization: require scoped per-user app authorization, explicit tool/accessory allowlists, default read-only behavior, token validation/revocation, and audit records before actual household data crosses that route. OpenAI's MCP authentication guide describes OAuth authorization-code flow with PKCE and server validation of issuer, audience, expiration, and scopes. Authentication scaffolding is not a claim of a finished security implementation. [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt), [MCP authentication](https://developers.openai.com/plugins/build/auth)

Dots can use supported installed/enabled plugins according to account permissions and execution environment. Connecting a personal computer is an explicit Allow access flow; it is not implicitly granted by a request to build software. OpenAI documents voice coordination of Chat, Work, and Codex tasks, subject to permissions and rollout. Neither page proves a particular dot voice session can discover and invoke this private custom MCP. Require an observed **synthetic read-only** tool call from the intended dot/voice surface after user-approved setup before calling that feature connected. [Dot computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps), [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice)

The Realtime API separately documents voice tool calls and remote MCP, but an application built on that API is a distinct client requiring API configuration and possibly usage costs. It must not be presented as enabling this existing dot call. [Realtime tools](https://developers.openai.com/api/docs/guides/realtime-mcp)

## Public implementation references

- [HomeClaw](https://github.com/omarshahine/HomeClaw) is MIT-licensed. Its documented macOS 26/Xcode 26 minimum is its own project choice, not a new native-macOS HomeKit API. It uses a Catalyst app, local IPC and an MCP wrapper; its public README highlights development signing and provisioning. Read for architectural context only.
- [HomeMCPBridge](https://github.com/coalsi/HomeMCPBridge) is MIT-licensed. Although its README says macOS 14+, its build instructions select **My Mac (Mac Catalyst)**. Its camera examples do not establish HSV history access. No installer/release or runtime claim from that repository is treated as validation for our project.

## Required proof gates

1. Compile the original Catalyst target without HomeKit initialization; validate mock native/MCP contracts and policy tests.
2. User selects an authorized signing team/profile and explicitly starts HomeKit access in the app. Stop at the system permission step for the user.
3. User grants access, then chooses an accessory allowlist locally. Perform only an approved read-only validation. Permission alone does not authorize camera capture or physical control.
4. Separately verify camera snapshot/export feasibility using an approved camera before selecting any recording schedule, storage destination, retention, keys, or ongoing access.
5. After approved private-connector/auth setup, verify one synthetic read-only call from the actual intended dot/voice surface. Then separately approve any household data sharing and future action scope.

Until those gates are observed, real hardware access, camera history, prospective capture, remote authentication, and dot voice operation remain unverified. The HSV/iCloud recorded-history API gap is a platform feasibility blocker, not a missing user permission.

## Bounded local storage and Google Drive archive evaluation

The product design evaluates a **temporary Mac cache with a 20 GB draft cap and hard 50 GB ceiling** to bound resource use. The draft is not an active allocation or recording setting; do not automatically grow toward 50 GB. Count the spool, pending/staging writes, indexes, thumbnails, retry state, logs, and downloaded/decrypted working files within an explicit local storage budget. Preserve a separately chosen free-disk reserve. At the cap or low-disk threshold, stop new capture/ingestion, report the reason, and show the resulting coverage gap. Never expand the cache, silently spill to another destination, or run continuous heavy analysis or transcoding to make space. Perform bounded, low-concurrency encryption and transfers; archive approved source data without continuous recompression.

No exact retention period, automatic deletion rule, capture cadence, free-disk reserve, or active cache default is selected. The **7–30 day retention range is a planning range**. Quota and retention are independent: a small queue cannot guarantee that many days during a destination outage. At the earlier illustrative four-camera continuous 2 Mbps rate, even an otherwise empty 20 GB queue holds only about **5.6 hours**, before overhead/reserve. This is another reason not to assume continuous capture is practical or publicly supported.

Google Drive is evaluated as a destination for **client-encrypted archive objects** after separate approval for household-data transfer, credentials, destination, retention, and persistent access. Storage availability must be checked for each deployment. An existing general Drive connection does not itself approve camera uploads. No account, file, free-space value, connection, OAuth application, credential, upload, or sharing setting was inspected or changed for this evaluation.

| Destination design | Practical benefit | Failure/operating limit |
| --- | --- | --- |
| Bounded Mac spool → NAS | Local transfers; ciphertext and keys can remain within the household's chosen boundary | A powered-off NAS accepts no archive transfers. The Mac queue fills and ingestion stops at its cap; restarting the NAS does not reconstruct the gap. Model, protocol, free space and durable-write behavior are unknown. |
| Bounded Mac spool → Google Drive encrypted archive | NAS can remain off; already uploaded objects are independent of household NAS power | New uploads need the Mac and internet to work. Outage, upload throttling, expired consent, full cloud storage or API quota can fill the same bounded queue. Cloud storage does not turn Drive into a HomeKit recorder. |

In either design, the Mac is still the proposed HomeKit capture host. If it sleeps, shuts down, loses power, or loses HomeKit access, this design captures no new material; cloud archive capacity does not change that. Keep an honest coverage ledger and statuses such as `queued`, `uploading`, `verified_archive`, `unavailable`, and `capture_stopped`. Release local payload space only after upload completion and archive-integrity acknowledgement are durably recorded; retention cleanup and deletion require the eventual approved policy. An uploaded archive is not proof that all camera events were observed.

For Drive, encrypt payloads **and sensitive manifests locally** with authenticated encryption; use opaque object names and keep decryption keys outside Drive in a later approved secure key store. Object size and upload timing remain observable to the storage provider. Google-side image preview, native content search and event recognition cannot be assumed for ciphertext. Search should use the local event index and retrieve/decrypt only a bounded object on demand. The same local quota must cover downloads and temporary processing. Key recovery, rotation, deletion and archive restoration need a tested design before production capture.

Drive supports resumable uploads and recommends them for interrupted networks; this is appropriate for bounded archive objects. Persist retry/session state securely, confirm the server's received offset after interruption, use idempotent object identities, and avoid duplicate uploads after a restart. Google's documentation also warns that resumable session URIs expire, so recovery must tolerate starting a new session. [Drive upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

API throughput and storage capacity are separate. Google's current quota documentation changed the model on 1 May 2026, with some older projects retaining previous quotas. It documents per-project/per-user quota units, quota errors requiring exponential backoff, and a **750 GB/day upload/copy constraint specifically for Workspace users**. Account type, project quotas and any applicable transfer/billing thresholds must be checked before setup; unused Drive space is not unlimited upload bandwidth or a no-cost guarantee. Do not enable billable usage or request paid quota increases. [Drive usage limits](https://developers.google.com/workspace/drive/api/guides/limits)

Use an explicit upload-rate/concurrency limit and defer work while the Mac is under load. A planning upper bound for an otherwise unused uplink is `GB/hour = upload Mbps × 0.45`; protocol overhead and competing traffic reduce it. For example, 10 Mbps is at most 4.5 GB/hour, so a 20 GB backlog needs at least about 4.4 hours to clear **with no new ingestion**. If average new data exceeds sustained upload capacity, a larger cloud account cannot prevent local-cap stops.

If a Drive adapter is later authorized, request the narrowest scope that can create/manage its own archive objects, normally `drive.file`, and a user-selected destination; avoid broad all-Drive access. Google's guide distinguishes per-file scope from restricted broad scopes and requires user OAuth consent. Verify restore/delete operations stay within the application's own archive set. Credential creation and ongoing refresh-token access remain pending user approval. [Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

This remains design/evaluation only. No recorder, archive uploader, NAS mount, retention job, automatic deletion, continuous analysis, or cloud recording path was enabled.
