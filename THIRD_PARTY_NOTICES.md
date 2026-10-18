# Dependencies and architectural references

This project's implementation was authored independently. No source code was copied from HomeClaw or HomeMCPBridge, and neither project was installed or rebranded. **No license for this project's code has been selected.** Public GitHub publication does not select a project license or authorize package/image releases.

Pinned direct dependencies:

| Package | Version | Published license | Use |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 | MCP protocol/server implementation |
| `zod` | 4.6.7 | MIT | Runtime input validation |
| `@modelcontextprotocol/client` | 2.3.1 | Apache-2.0 | Development/smoke client |
| `typescript` | 7.0.2 | Apache-2.0 | Compiler |
| `@types/node` | 22.20.5 | MIT | Development type declarations |

`package-lock.json` pins the full dependency graph. Upstream license and attribution files remain in installed packages. A release or redistribution package needs a separate review of direct/transitive notices and the selected product license. Apple's frameworks and developer tooling retain their applicable platform/toolchain terms; this work did not accept any new terms.

Architectural reading only: [HomeClaw](https://github.com/omarshahine/HomeClaw), [HomeMCPBridge](https://github.com/coalsi/HomeMCPBridge), both MIT according to their public repositories. Research references are recorded in [research.md](docs/research.md). Our actual platform claims are backed by the installed SDK, compiler and primary Apple documentation rather than either repository's marketing/runtime minimum.
