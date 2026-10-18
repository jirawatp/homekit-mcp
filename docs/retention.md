# Prospective cache retention and recovery

Status: **design and synthetic planners only**. No camera recording, media filesystem access, deletion, NAS mount, upload, credential creation or space reservation is implemented by these modules. This does not provide access to existing HomeKit Secure Video/iCloud recordings. Any future cache starts with a separately authorized, publicly supported capture source; feasibility of saving HomeKit camera output must be established separately from displaying a live view or receiving a snapshot.

The product design evaluates retention in the **7–30 day range**; no exact age, archive quota or eviction policy is active. The Mac spool design uses a **draft 20 GB cap**, configurable to a **hard maximum of 50 GB**, with a separately chosen free-disk reserve. These are decimal GB. Nothing allocates 20 GB, enables recording, or approves automatic deletion. Any NAS destination requires deployment-specific free-space, protocol, power-recovery and durable-write validation. No hardware purchase is required by this design.

## Implemented pure APIs

`src/retention.ts` exports:

```ts
planRetention(inventory, policy, nowMs, disk, pendingWrite?)
```

Every production policy value must be explicit. There is no active retention default. The result contains whole-bundle deletion candidates, projected retained/reclaimed bytes, projected free space, `allowCapture` and an explicit stop reason. An omitted or invalid peak write budget stops capture. `allowCapture` is a **projection after successful eviction**, not permission to write or proof that space has been reclaimed. A future executor must confirm authorized deletions, rescan and check actual free space before allocation. Failed unlink, stale inventory, denied permission, unknown files or exhausted storage must stop capture.

The planner applies maximum age, total bytes, separate temporary/log age and byte quotas, and a volume free-space reserve. It evicts oldest first, with deterministic identifier ordering for equal timestamps. A segment's encrypted media, thumbnails, per-segment index and metadata are one bundle, so the cleanup plan does not leave those associated files behind. An impossible prospective write cannot evict otherwise valid data just to attempt a write that will never fit.

`src/recovery.ts` exports:

```ts
planStartupRecovery(manifest, nowMs, maximumShortSegmentDurationMs)
planLocalSpoolWrite(inventory, policy, nowMs, disk, proposedSegment, nasAvailable)
```

The spool checks the existing volume's capacity **before allocation**, counts peak segment/sidecar/staging bytes, rejects caps above 50 GB, and never increases its cap when the NAS is offline. It stops if cleanup would be needed. Its retention result is only a preview because deleting unarchived footage has not been selected as a policy. Missing coverage is returned as `availability: "unavailable"` with an interval and reason. An outage or capacity gap never means that no person or event was present. Gap/status records must themselves rotate within the bounded metadata/log budget.

The tests use synthetic manifests and arithmetic only. They cover whole-bundle cleanup, age boundaries, ordering, independent temp/log bounds, overflow, unsafe paths, symlink uncertainty, invalid/future timestamps, quota/reserve stops, interrupted writes, orphan finalized segments, missing media, corrupt integrity, NAS outage and the 50 GB ceiling. They do **not** establish disk, NAS, encryption or power-loss durability.

## Ownership and deletion boundary

The planner accepts only namespace `homekit-mcp-cache-v1` and strict logical member names:

```text
captures/<bundle-id>/<filename>
temporary/<bundle-id>/<filename>
logs/<bundle-id>/<filename>
```

It rejects absolute paths, `..`, Windows paths, encoded separators, arbitrary nested directories, duplicate members, special files, unverified symlinks/ancestors, inconsistent disk facts and oversized inventories. A planner inventory is limited to 10,000 bundles and 16 members each. Larger deployments must partition by independently enforced policy domains and preserve an aggregate global quota, or implement a bounded streaming planner; silently truncating an inventory is forbidden. All byte/time values use safe integers. Corrupt/future records fail closed with no deletion targets.

The verification flags are **facts a future trusted scanner must establish**; callers supplying `true` do not prove ownership. There is currently no scanner or deletion executor. Before any executor is enabled it must use a dedicated private application root on the intended volume, enumerate every file, verify ownership/type/inode and every ancestor, refuse symlink or mount substitution, and anchor operations to an opened directory handle. Revalidate members immediately before operations to prevent path replacement races. Never take arbitrary root paths or deletion targets from an MCP request. Unknown files stop cleanup rather than becoming deletion candidates. Do not recurse outside the application root, follow links, delete unrelated NAS folders or purge iCloud/Drive files.

Shared search indexes, database journals/WAL, thumbnails, temporary uploads, encryption overhead, retry queues and logs all consume the same budget. The current mock model represents index data as per-segment members; a future shared database adapter must transactionally remove corresponding rows, thumbnails and derived metadata, checkpoint/truncate bounded journals, and account for actual reclaimed space. Hiding a row or moving a file to trash does not establish reclaimed bytes. Crash tombstones and diagnostic logs must also have explicit age/byte caps; redact camera names, imagery, people and credentials from operational logs.

## Power interruptions and consistency protocol

The draft commit protocol is exported as `SEGMENT_COMMIT_PROTOCOL`. A future implementation should use short segments with explicitly bounded duration and peak size:

1. Check physical free space, reserve and total peak bytes before starting.
2. Write an authenticated encrypted segment and minimal authenticated manifest to an owned local temporary bundle.
3. Flush files and verify the media/manifest integrity; atomically finalize the whole bundle on the same local filesystem; flush the containing directory.
4. Commit the local search-index transaction only after media finalization. Publish it to search only after the index is committed.
5. On startup, reconcile before capture resumes. Discard incomplete temporary bundles under the approved policy; reindex authenticated orphan finalized media; remove dangling indexes/sidecars for missing media; mark corrupt/unverifiable media unavailable in place. Quarantine must not create an extra copy or bypass quotas.

The recovery planner models those crash states and blocks capture while reconciliation actions remain unexecuted. The executor must make them idempotent and re-inventory after interruption. A durably acknowledged quarantine remains unavailable and counts toward storage, but does not repeatedly block capture on every startup. Persist coverage checkpoints/gaps within the metadata quota. A fully indexed, authenticated segment can remain searchable; a partial, corrupt or missing segment must never be returned as a valid clip.

An atomic local rename does not prove a NAS has durably persisted a transfer. Keep the index local; do not put its live database on an unverified network share. A future archive adapter should stream one encrypted immutable segment at a time, resume bounded transfers, verify the destination object and record a confirmed archive receipt before considering a local copy removable. Power can fail between any two operations. Do not treat an upload request or a filename appearing on a share as a durability receipt. NAS restart/reconnect requires reconciliation and a fresh free-space/health check. Any local mountpoint must be verified as the intended remote filesystem, so a disconnected share cannot silently turn into an unlimited local directory.

## Storage choices and sizing

| Choice | Proposed role | Limits to resolve before enabling |
| --- | --- | --- |
| Mac | Native HomeKit bridge, local index and bounded short-segment spool | Check available disk, choose reserve, keep within the draft 20 GB / hard 50 GB ceiling; no continuous heavy analysis/transcoding |
| NAS | Candidate private encrypted archive | Measure free space; choose explicit age and quota; verify protocol, credentials, durability and power recovery with synthetic fixtures first |
| Separate server | Optional future encrypted archive | No provisioning chosen; quantify cost/network/privacy and retention before any service or credential changes |
| Google Drive | Optional encrypted archive after separate permission | Requires explicit authorization for household-data upload and credentials; keep one controlled upload, bandwidth cap, bounded retries and staging in Mac quota |

Illustrative sizing, **not a selected recording mode or policy**: a 1 Mb/s stream produces about 10.8 GB/day before overhead. Four such streams produce about 302 GB in 7 days or 1.30 TB in 30 days. At that rate a 20 GB spool holds roughly 11 hours and 50 GB roughly 28 hours; higher bitrates shorten those intervals. Rated volume capacity is not available archive space. Encryption, sidecars, reserve, other data and filesystem overhead reduce useful capacity. Event-triggered stills may be much smaller, but missed intervals and actual camera/API rate limits must be visible. Do not promise continuous footage from periodic snapshots.

Prefer doing analysis on a requested time range with explicit resource/concurrency budgets. Recording and continuous transcoding/vision inference must not silently consume the Mac's CPU/GPU. No facial recognition, named-person appearance tracking or household data transmission is part of this design.

Drive is only an evaluated later option. Google's [resumable-upload API](https://developers.google.com/workspace/drive/api/guides/manage-uploads) supports interrupted transfers. [Drive for desktop](https://support.google.com/drive/answer/13401938?hl=en) streaming still uses a local cache and mirroring uses local copies, so neither substitutes for this application's bounded spool. [Trashed files still consume Drive storage and are normally permanently deleted after 30 days](https://support.google.com/drive/answer/2375102?hl=en). Automatic permanent purge is not authorized; a future archive adapter must stop uploads when it cannot reclaim storage under the selected policy. No Drive functions, uploads or keys are implemented here.

Before real recording: establish a supported HomeKit capture path and user approval; choose exact age, NAS quota/free-space reserve, Mac reserve and full-cache behavior; confirm encryption/key recovery and archive access; then run synthetic fault-injection tests on the actual selected storage. Current planners do not remove those blockers.
