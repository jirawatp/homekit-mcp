# Docker deployment

The Swift HomeKit app runs on macOS. The TypeScript MCP process runs in a Linux
container. Linux Docker cannot load Apple's HomeKit framework or inherit the
Mac's HomeKit permission. This implementation starts only a synthetic MCP server
by default. It has no recording worker or persistent media/index volume.

## Validated environment

On 2026-10-18 the validation client reported Docker 29.0.1 (darwin/arm64) and Compose
v2.40.3-desktop.1. `docker version` could not reach an engine because
`/var/run/docker.sock` did not exist. No engine was started and no Docker settings
were changed. Image build, Linux execution, resource-limit enforcement, and the
Docker-to-Mac TLS route therefore remain untested. A remote manifest check also
failed DNS resolution for `registry-1.docker.io` in the execution environment.

The exact release/distribution tag `node:22.23.3-bookworm-slim` is published in
the [official Node image manifest](https://github.com/docker-library/official-images/blob/master/library/node).
The [Node release index](https://nodejs.org/download/release/latest-v22.x/) also
lists 22.23.3. An exact version tag still permits upstream base-layer rebuilds;
resolve and review its image digest when the registry is reachable, then pass
`--build-arg NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:REVIEWED_DIGEST` for an
immutable base. No digest has been invented or claimed verified here.

## Build and test with synthetic data

Run from the project folder after starting an already configured Docker engine.
Installing Docker or accepting new Docker terms is outside these instructions.

```sh
docker compose config --quiet
docker build --tag homekit-mcp:local --target runtime .
node scripts/smoke-docker.mjs
```

The build uses the committed npm lock with `npm ci --ignore-scripts`, compiles
TypeScript, and runs the synthetic Node test suite under the same 90% coverage gate as `npm test` (`.c8rc.json` and the inventory script are in the build context allowlist; this stage has not been executed here because no Docker engine was started). The final image contains only
production npm dependencies, compiled application code, package metadata, and
the mock allowlist. Swift, signing assets, household configuration, certificates,
tokens, tests, and local media are excluded from the final image. The build
context itself is allowlisted by `.dockerignore`.

The smoke test uses the official MCP client to start a single disposable
container over stdio, complete initialization, list read-only tools, read mock
status/accessories/events, and confirm that a non-allowlisted read is refused.
It requires an existing local image and never pulls or builds automatically.
It opens no ports, uses `--network=none`, and mounts no host files. Exit code 2
means the engine or local image is unavailable, not that the test passed.

To start a mock stdio MCP process manually:

```sh
docker compose run --rm --no-deps -T mock
```

Use `run`, not a detached `up`: MCP stdio needs a live stdin/stdout connection to
a local MCP client. No persistent client configuration is installed by this
command. A cloud dot voice session cannot reach this stdio process directly.
The separately approved connector path remains required.

## Resource and storage boundaries

Both Compose services use a read-only root filesystem, a non-root user, no added
Linux capabilities, no privilege escalation, 192 MiB memory with no extra swap,
half of one CPU, 64 PIDs, and a 16 MiB temporary filesystem. Compose engine logs
are limited to two 1 MiB files; the disposable smoke uses no engine log driver.
No ports, Docker socket, NAS, Drive folder, Home database, or media directory are
mounted. There is no restart policy or background service installation.

These are MCP runtime limits, not an allocated 20 GB cache. Future media capture
requires separate approval, a checked free-disk reserve, an application-owned
bounded spool, age/quota retention, and crash recovery. A Docker named volume does
not by itself provide a reliable hard media quota on Docker Desktop. Do not add
an unbounded volume or bind mount as an interim cache.

Image layers, npm build downloads, and Docker's build cache use Docker's own disk
image outside the runtime limits. Check Docker Desktop's current disk usage and
free space before any build. Nothing here resizes that disk
image, preallocates media storage, enables continuous analysis, or prunes existing
images/caches belonging to other projects.

## Optional native host bridge (approval and verification pending)

The `host` service is behind the explicit `host` profile. Starting it does not
launch or authorize the native app. First complete native signing/provisioning,
approve HomeKit access, select a read-only accessory allowlist, and explicitly
approve creation/use of the local TLS identity and token. Those actions have
not happened. Do not generate credentials or accept permission prompts during
mock setup.

The service expects three existing read-only files: a configuration JSON, CA PEM,
and token. Configure `HOMEKIT_ACCESS_CONFIG`, `HOMEKIT_BRIDGE_CA`, and
`HOMEKIT_BRIDGE_TOKEN` with their absolute paths. Missing files fail instead of
creating empty host directories. Keep the token owner-only (0600), then select a
matching non-root UID/GID for the container; verify Docker Desktop actually
preserves readability for that UID. Do not make the token world-readable to
work around a mount permission failure.

After those approvals and files exist, a future local client may launch:

```sh
HOMEKIT_RUN_UID="$(id -u)" HOMEKIT_RUN_GID="$(id -g)" \
  docker compose --profile host run --rm --no-deps -T host
```

The proposed URL is `https://host.docker.internal:18443/bridge`; the supplied CA must
validate that hostname and the TLS connection must authenticate with the scoped
token. A profile is not proof of access approval. The HTTPS gateway must stay
bound to Mac loopback; this container publishes no ports. No `0.0.0.0` binding,
certificate bypass, host networking switch, or unauthenticated fallback is
provided.

Docker Desktop runs its engine in a Linux VM, and its backend creates host-side
connections. Its [networking documentation](https://docs.docker.com/desktop/features/networking/)
describes that boundary; a successful Docker-to-loopback route has not yet been
established on the validation host. Verify the route with synthetic gateway data
and TLS first. If `host.docker.internal` cannot reach a loopback-only gateway,
stop and resolve the boundary through an approved local relay or integration;
do not expose the HomeKit bridge to the LAN as a workaround. Native Linux Docker
on a NAS cannot supply the Mac HomeKit framework, and its host networking names
and routing differ.

The host profile permits networking needed for that bridge but is not a general
container egress firewall. Only the reviewed gateway endpoint should be configured.
No recording, camera images, cloud archive, device actuation, or remote dot
connection is enabled by either service.
