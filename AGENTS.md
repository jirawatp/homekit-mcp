# Working in this project

## Required Cursor model and quality workflow

The project-scoped `.cursor/rules/project-workflow.mdc` is always active. Use GPT-5.6 Sol (`gpt-5.6-sol`) as planner/designer, Claude Sonnet 5.5 (`claude-sonnet-5-5`, the owner's spelling is "Sonet") as worker, and Claude Opus 5.5 (`claude-opus-5-5`) as reviewer/advisor. Project subagent definitions live in `.cursor/agents/`. Verify actual model execution permission, not only picker visibility; stop and report any block or fallback instead of substituting. Rules do not prove models executed.

Require meaningful >=90% statements, branches, functions and lines for all production TypeScript, including unloaded files, entrypoints and security/error handling. Enforce this in test configuration and CI. Do not lower thresholds or broadly exclude difficult modules. Report native supported metrics with exact source/target scope; Foundation fixture coverage does not establish coverage of the Catalyst app. Complete the plan, worker changes, independent review, reproducible checks and accurate documentation before claiming completion.

## Scope and safety

This is an original HomeKit MCP implementation. Publication as the public GitHub repository `jirawatp/homekit-mcp` is approved. That approval does not select a code license or authorize releases, container-image publication, npm publication, credentials, signing/account changes, network exposure, recording, or persistent access. Do not copy/rebrand reference projects or introduce Home Assistant/vendor camera integrations; the camera layer is HomeKit.

- Read `README.md` and `docs/validation.md` to distinguish implemented, mocked and pending stages.
- Safe default is synthetic, read-only STDIO. Real HomeKit lives in the Catalyst app, never Linux Docker. `HMHomeManager` initialization is a foreground user action, not a tool or startup side effect.
- User signing/account changes, HomeKit/camera permission, persistent access, TLS/token creation, service exposure and household-data transfer need the applicable explicit approval. Do not auto-accept prompts. Prepared flags/snippets are not evidence of approval.
- No device actuation or lock/garage control exists. Keep accessory allowlists and safe scalar filters in both native and TypeScript layers. Do not identify or locate named people by camera appearance.
- Public HSV history and raw media export are separate feasibility gates. Never report synthetic events or snapshots as existing iCloud history.
- Cache modules are pure planners. No recording, real deletion, NAS mounts or uploads are authorized. Product design evaluates a draft local cap of 20 GB, hard ceiling of 50 GB, no automatic growth, free-space reserve and visible stop/gaps. Exact retention/eviction remains unselected; 7–30 days is a planning range, not an active setting.
- Keep tests/resource use modest. `npm test`, `npm run smoke`, `npm run test:native`, `npm run smoke:native`, and `npm run build:native` are synthetic/build-only. `npm run smoke:docker` requires an already available engine and image; do not start Docker or alter its settings automatically.
- Do not modify shared/global MCP clients or other projects. `scripts/client-config.mjs` prints disabled snippets only. Cloud dot cannot directly reach local pipes/loopback.
- Keep public documentation and examples portable. Do not publish local usernames/paths, disk measurements, household topology, storage ownership/capacity, power history, camera imagery, tokens, certificates, or private configuration. Use `/absolute/path/to/project` placeholders and synthetic fixtures. Keep raw local environment diagnostics untracked.

The user's later explicit instructions take precedence over project guidelines. Report precise remaining approval/platform blockers and never imply unfinished runtime proof passed.
