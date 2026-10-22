# Optional macOS HTTPS host gateway

This optional component keeps the signed Swift HomeKit bridge on macOS while a Docker container runs the MCP server and pure index/storage planning code. There is no active recording index worker. The gateway is implemented but has **not been started or tested with a real network, TLS credentials, HomeKit authorization, or household data**. Tests use injected fakes, synthetic request bytes and harmless temporary files only (see Verification performed).

The gateway binds only `127.0.0.1:18443`, requires TLS 1.3 and a dedicated bearer token, and serves one route: `POST /bridge`. It is a local bridge for an approved Docker Desktop client. It does not make dot cloud able to reach this Mac, and it is not an OAuth connector or a remotely hosted MCP service.

## Pending user actions and approvals

Before running this component, the user must separately authorize starting the native HomeKit helper and starting the local HTTPS gateway. The two command flags record those approvals; an agent must not supply them merely because they exist in this document. HomeKit permission prompts, Apple signing/account access, real device discovery, credential creation, and persistent access remain separate user actions.

The user must supply all of the following. This project does not generate or install them:

- A signed native bridge executable on this Mac.
- An explicit read-only accessory allowlist configuration. The default empty allowlist exposes no accessories. The file must be regular, owned by the current macOS user, at most 64 KiB, and readable only by that owner (for example, `0600` or `0400`).
- A dedicated token file containing 32–128 ASCII base64url characters, optionally followed by one newline. It must be regular, owned by the current user, readable only by that owner, and at most 256 bytes. The synthetic string in unit tests is not a credential to use for access.
- A private TLS key file that is regular, owned by the current user, readable only by that owner, and at most 128 KiB. Encrypted keys requiring an interactive passphrase are not supported by this CLI.
- A matching PEM TLS certificate/chain file of at most 128 KiB. This public file may be world readable but must not be writable by a group or by others. Its leaf certificate must be valid now and have the explicit DNS SAN `host.docker.internal`. Wildcard/subject-name fallback is not used.
- A trusted CA certificate provided explicitly to the Docker client. The private TLS key stays on the host. Do not disable certificate verification or set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Supplied credential and configuration paths must be absolute. Final path components must not be symlinks or special files. TLS material, token, allowlist schema, and executable metadata are checked before the native helper is spawned. Credentials are not logged.

## Authorized startup command

The following is a template for the user after those approvals and files exist. It has not been executed:

```sh
node dist/src/host-gateway.js \
  --bridge /absolute/path/HomeKitMCPBridge.app/Contents/MacOS/HomeKitMCPBridge \
  --config /absolute/path/read-only-allowlist.json \
  --token-file /absolute/path/host-token \
  --cert-file /absolute/path/host-cert.pem \
  --key-file /absolute/path/host-key.pem \
  --port 18443 \
  --native-user-approved \
  --host-bridge-user-approved
```

The process runs in the foreground with no automatic startup service. `SIGINT` or `SIGTERM` closes the listener and helper. It deliberately has no bind-address option. If Docker Desktop cannot reach the host loopback listener via `https://host.docker.internal:18443/bridge`, stop and investigate the local network setup. That route is **unverified**; do not broaden the listener to `0.0.0.0`, add a tunnel, or expose a public endpoint as a workaround.

## Protocol and limits

Each request requires `Authorization: Bearer <dedicated token>` and `Content-Type: application/json` (optional UTF-8 charset). Browser `Origin` headers are rejected and no permissive CORS headers are returned. Duplicate security headers, compressed bodies, wrong routes/methods, oversized bodies, and malformed or extra command fields fail before the bridge is accessed.

Only these exact read requests are accepted:

```json
{"command":"status"}
{"command":"list_accessories"}
{"command":"read_accessory","accessoryId":"AN-EXPLICITLY-ALLOWLISTED-ID"}
```

Successful responses have `{"ok":true,"result":...}`. Failures have `{"ok":false,"error":{"code":"GENERIC_CODE"}}`; native error text, paths, device names, and stack traces are withheld. The existing `HomeKitBridge` wrapper enforces the accessory allowlist, the read-only characteristic policy, and scalar response validation. The Swift helper independently applies its read policy. No command performs actuation, changes HomeKit configuration, fetches camera media, or reads HSV/iCloud recording history.

Requests are bounded to 64 KiB, headers to 16 KiB, serialized responses to 1 MiB, and connections to four. Header/body/socket timeouts are bounded; every response closes the connection and is marked `Cache-Control: no-store`. Token comparison uses a constant-time comparison for equal-length candidates. The gateway never forwards native helper diagnostics or emits household request logs.

## Verification performed

`test/host-protocol.test.ts` covers authenticated read dispatch, approval/argument parsing, route and method rejection, Origin and duplicate-header rejection, malformed/oversized bodies, disallowed commands, the real wrapper's allowlist denial, bounded responses, and error redaction. Importing the gateway for these tests does not start it. No test creates real TLS keys, listens on a port, launches the native helper, or asks for HomeKit permission; `test/host-gateway.test.ts` and `test/https-transport.test.ts` do write synthetic temporary files described below.

`test/host-gateway.test.ts` (added 2026-10-21) drives `runHostGateway` through injected fakes for the platform, file opener, TLS primitives, HTTPS server, helper bridge and signals. It covers option parsing; bounded, owned, private-file checks; the executable checks; certificate/key/validity failures with parser text hidden; refusal of every bad credential or config before the helper or server exists; loopback-only exclusive binding with the documented limits; request rejection before the body is read; fixed error bodies; idempotent shutdown; and cleanup after failed startup, including failed signal registration. Separate tests use harmless temp files and bounded child processes to prove the default opener's symlink (`O_NOFOLLOW`) and FIFO (`O_NONBLOCK`) refusal, and run the module directly to confirm it refuses to start without approvals.

**No real credential was created.** The tests do write synthetic token-format strings and placeholder files into temporary directories, and delete them afterwards; none grants access to anything. Fake TLS primitives stand in for certificates, so real TLS behavior, a real listener, the native helper and HomeKit permission remain unverified.
