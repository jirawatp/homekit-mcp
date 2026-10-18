# homekit-mcp

An original HomeKit MCP implementation: TypeScript MCP tools and a Swift **Mac Catalyst** HomeKit app. The project does not install Home Assistant, HomeClaw or HomeMCPBridge or reuse their source code.

The working stage is a read-only prototype with actual MCP/Swift protocol tests. The HomeKit app compiles but has **not been development-signed/provisioned, launched or authorized**. Its compiler-generated ad-hoc linker signature has no Team or HomeKit provisioning. The final voice-controlled home and camera-history product is not connected yet.

## Current capabilities

| Feature | State |
| --- | --- |
| Local MCP STDIO initialization, discovery and calls | Working with the official MCP SDK |
| Native HomeKit app | Compiler and unsigned Xcode builds pass; real access awaits user signing/permission |
| Docker split deployment | Dockerfile/Compose ready; image/runtime test blocked by stopped engine |
| Accessory state | Explicit allowlist in both layers; safe Boolean/numeric sensor fields only |
| Camera event search | Working synthetic metadata demo; no real media |
| HSV/iCloud historical clips | Explicit `unavailable`; no documented public history API found |
| Anonymous room occupancy | Synthetic demo and native allowlisted sensor adapter, with freshness |
| Named-person room | Unavailable until separate consented device/presence signals exist; never camera identity |
| Retention, crash recovery, NAS-outage behavior | Pure, tested planners; no recording, allocation or deletion |
| Dot voice integration | Design and authorization boundary prepared; connection unverified |
| Device control | Not implemented or exposed; all tools are read-only |

## Run the safe local demo

Requires Node 22.19+; native builds additionally need full Xcode on a Mac. Public HomeKit is available through **Mac Catalyst**, not a native AppKit HomeKit module. See the [validated environment and portability limits](docs/environment.md).

```sh
npm ci --ignore-scripts
npm test
npm run smoke
npm run test:native
npm run smoke:native
npm run build:native
```

`smoke` creates an ephemeral SDK client and server using synthetic fixtures. `test:native` builds/tests Foundation-only code with no HomeKit import. `smoke:native` connects TypeScript to that Swift fixture while keeping stdin open. `build:native` compiles the real app **without launching it**. None of these commands discovers your home, records cameras, opens a listening port or changes client configuration.

To run STDIO manually for a compatible **local** client:

```sh
node dist/src/index.js --mode mock --config config/mock.json
```

STDOUT is protocol-only. Without `--config`, the accessory allowlist is empty. Synthetic camera/presence demos are always labelled `simulated: true`. They contain no household data, camera URL or image.

## Tools

- `homekit_get_status`: permissions, runtime and capability limits.
- `homekit_list_accessories`: allowlisted topology and previously observed safe values.
- `homekit_read_accessory`: refresh safe state for one allowlisted accessory.
- `homekit_search_camera_events`: synthetic event metadata; real HSV returns unavailable.
- `homekit_get_room_occupancy`: anonymous occupancy with timestamps; inactive motion is not proof of an empty room.
- `homekit_locate_consented_person`: currently unavailable; no consented personal signals configured.

For example, search mock motion events with `{"types":["motion"],"limit":10}` or query `{"roomId":"mock-room-living"}`. All timestamps include a timezone. Never translate missing or stale data into “nothing happened” or “nobody is there.”

## Local client setup, prepared only

```sh
node scripts/client-config.mjs
node scripts/client-config.mjs --native
node scripts/client-config.mjs --docker
```

These commands **print** disabled, separately named local Codex snippets. Prepared files are [mock](examples/codex.mock.toml), [Docker mock](examples/codex.docker-mock.toml) and [pending native](examples/codex.native.pending.toml). No shared or global client configuration was changed. Review the scope and enable only after the required access approval. Existing client files must be merged additively with a backup; do not replace them.

Committed examples contain `/absolute/path/to/homekit-mcp` placeholders. Replace those paths locally or regenerate a snippet with the commands above. Normal output contains private local executable/checkout paths; save it only in ignored `examples/*.local.toml` files. Add `--template` to print portable placeholder paths instead. For native setup, copy `config/homekit.example.json` to ignored `config/homekit.local.json` and use that same local file in both policy layers.

Local STDIO does not make the server reachable from dot cloud. A later approved private connector/tunnel and an observed synthetic call from the intended dot voice surface are required. See [architecture](docs/architecture.md) and [current primary-source research](docs/research.md).

## Docker deployment

Use [Docker setup](docs/docker.md) for the requested split: **native bridge on macOS, MCP in Docker**. Linux containers cannot load Apple HomeKit. The default image runs mock STDIO without network, mounts or recording; Compose bounds CPU, memory, temporary space and logs. The optional host profile uses the [gated HTTPS loopback gateway](docs/host-gateway.md), private CA and owner-only token files supplied after approval. No server has been started, no token/key/certificate generated, and no TLS check is bypassed.

On the validation host, Docker CLI/Compose were available but the engine socket was absent. Compose validation passes; `npm run smoke:docker` reports that blocker with exit 2. Actual image build, Linux execution, digest pinning and Docker-to-Mac loopback/TLS behavior remain unverified. Docker engine/build-cache disk use is separate from runtime/media quotas and must be checked before building. No Docker settings or other projects' images were changed.

## Real HomeKit: blocked at user setup

The validation build had **no development-signing identity or HomeKit provisioning**. Follow [native setup](docs/native-setup.md) to select an authorized Team/App ID/HomeKit provisioning in the included Xcode project. The project does not sign in, enroll, create credentials, accept terms or purchase services.

After that separate approval, the user must launch the native profile, select the allowlist JSON through the helper's picker, enable that session, and personally handle Apple's HomeKit prompt. Every helper launch starts disabled. Do not run the native profile as a shortcut around those steps.

The example configuration denies all accessories. Native mode needs actual accessory UUIDs, which are displayed only in the foreground app after authorization. Config edits require an MCP restart to synchronize both policy layers. Camera-profile accessories, sensitive services and binary/TLV/string characteristic values are excluded. See [the protocol and safe-read policy](docs/native-setup.md#data-and-protocol).

## Camera and storage feasibility

The camera design uses a single HomeKit standard layer across compatible camera brands. Public snapshot/live-view APIs do not establish access to existing HSV/iCloud clips. No supported public HSV historical catalogue/download API was found. Reliable exported media for a future cache also needs a supported-API feasibility test after separate camera permission; rendering a live view alone does not prove recording/export.

The future cache cannot recover old iCloud recordings. History would start when authorized capture begins. Storage design evaluates a **7–30 day planning range** and **20 GB draft local cap, configurable up to a hard 50 GB ceiling**, with no automatic expansion. No 20 GB allocation or active retention default exists. Exact retention, reserve, archive quota and eviction policy remain unset. NAS and Google Drive are evaluated only as optional encrypted archive destinations; no mount, upload, credential or ongoing access was created. See [bounded retention and recovery](docs/retention.md).

## Project map

```text
src/             MCP tools, policy, transport, synthetic events/presence, pure cache planners
native/          original Catalyst app, pure Swift core/tests and synthetic protocol fixture
scripts/         build, diagnostics, ephemeral smoke clients, print-only integration snippets
config/          explicit deny-all real example and synthetic demo allowlist
docs/            setup, architecture, research, storage/recovery and validation evidence
```

Dependencies are pinned with `package-lock.json`; npm lifecycle scripts are not required. **No license for this project's code has been selected.** Public repository publication does not select a license or authorize package/image releases. [Third-party notices](THIRD_PARTY_NOTICES.md) describe dependencies and references.

[Validation results and remaining proof gates](docs/validation.md) distinguish tested behavior from hardware, Docker and network work still pending.
