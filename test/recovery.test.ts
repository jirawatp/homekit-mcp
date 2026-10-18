import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAFT_LOCAL_SPOOL_MAX_BYTES, HARD_LOCAL_SPOOL_MAX_BYTES,
  planLocalSpoolWrite, planStartupRecovery,
  type LocalSpoolPolicy, type RecoveryEntry, type RecoveryInventory,
} from '../src/recovery.js';
import { CACHE_NAMESPACE, MAX_CACHE_RECORDS, type CacheKind, type CacheRecord, type RetentionInventory } from '../src/retention.js';

const now = 10_000;
const GB = 1_000_000_000;
const dirs: Record<CacheKind, string> = { capture: 'captures', temporary: 'temporary', log: 'logs' };
function bundle(id: string, bytes = 100, kind: CacheKind = 'capture', createdAtMs = 9_000): CacheRecord {
  const files: CacheRecord['files'] = [
    { relativePath: `${dirs[kind]}/${id}/data.bin`, byteLength: bytes - 2,
      role: kind === 'capture' ? 'media' : kind, regularFile: true, symlinkFreePath: true },
    { relativePath: `${dirs[kind]}/${id}/metadata.bin`, byteLength: 1, role: 'metadata', regularFile: true, symlinkFreePath: true },
  ];
  return { id, kind, createdAtMs, files: kind === 'capture' ? [...files,
    { relativePath: `captures/${id}/index.bin`, byteLength: 1, role: 'index', regularFile: true, symlinkFreePath: true },
  ] : [{ ...files[0]!, byteLength: bytes - 1 }, files[1]!] };
}
function entry(id = 'segment'): RecoveryEntry {
  return { bundle: bundle(id), phase: 'finalized', startMs: 9_000, endMs: 9_500,
    mediaPresent: true, indexPresent: true, metadataPresent: true, authenticatedIntegrityVerified: true, quarantined: false };
}
function recovery(entries: readonly RecoveryEntry[]): RecoveryInventory {
  return { namespace: CACHE_NAMESPACE, applicationOwned: true, complete: true, rootAndAncestorsAreSymlinkFree: true, entries };
}
function inventory(records: readonly CacheRecord[] = []): RetentionInventory {
  return { namespace: CACHE_NAMESPACE, applicationOwned: true, complete: true, rootAndAncestorsAreSymlinkFree: true, records };
}
const spoolPolicy: LocalSpoolPolicy = {
  maxBytes: DRAFT_LOCAL_SPOOL_MAX_BYTES, maxAgeMs: 100_000,
  minFreeDiskBytes: 10 * GB, maxSegmentBytes: 2 * GB, maxSegmentDurationMs: 1_000,
};
const disk = { freeBytes: 60 * GB, totalBytes: 100 * GB, inventoryOnSameVolume: true };
const proposed = { startMs: now, endMs: now + 500, maximumBytes: GB };

test('recovery keeps only authenticated finalized media with committed metadata and index searchable', () => {
  const result = planStartupRecovery(recovery([entry()]), now, 1_000);
  assert.equal(result.valid, true);
  assert.equal(result.captureMustRemainStopped, false);
  assert.equal(result.actions[0]?.action, 'keep');
  assert.equal(result.actions[0]?.searchable, true);
  assert.deepEqual(result.gaps, []);
});

test('power failure during temporary write discards only that owned bundle and marks interruption through restart', () => {
  const incomplete: RecoveryEntry = { ...entry(), bundle: bundle('segment', 100, 'temporary'), phase: 'writing',
    indexPresent: false, authenticatedIntegrityVerified: false };
  const result = planStartupRecovery(recovery([incomplete]), now, 1_000);
  assert.equal(result.actions[0]?.action, 'discard-incomplete');
  assert.equal(result.actions[0]?.searchable, false);
  assert.equal(result.captureMustRemainStopped, true);
  assert.ok(result.actions[0]?.files.every((file) => file.relativePath.startsWith('temporary/segment/')));
  assert.deepEqual(result.gaps, [{ startMs: 9_000, endMs: now, reason: 'power-loss-incomplete', availability: 'unavailable' }]);
});

test('crash after durable finalization but before index commit schedules authenticated reindex then idempotent keep', () => {
  const orphan = { ...entry(), indexPresent: false };
  const first = planStartupRecovery(recovery([orphan]), now, 1_000);
  assert.equal(first.actions[0]?.action, 'rebuild-index');
  assert.equal(first.actions[0]?.searchable, false);
  assert.equal(first.captureMustRemainStopped, true);
  assert.deepEqual(first.gaps, []);
  const second = planStartupRecovery(recovery([{ ...orphan, indexPresent: true }]), now, 1_000);
  assert.equal(second.actions[0]?.action, 'keep');
  assert.equal(second.actions[0]?.searchable, true);
});

test('missing media removes dangling index and sidecars without pretending history is empty', () => {
  const result = planStartupRecovery(recovery([{ ...entry(), mediaPresent: false }]), now, 1_000);
  assert.equal(result.actions[0]?.action, 'remove-dangling-index-and-sidecars');
  assert.deepEqual(result.actions[0]?.files.map((file) => file.role), ['metadata', 'index']);
  assert.equal(result.gaps[0]?.reason, 'missing-media');
  assert.equal(result.gaps[0]?.availability, 'unavailable');
  assert.equal(result.actions[0]?.searchable, false);
});

test('corrupt integrity or missing authenticated metadata quarantines in place without publishing or copying media', () => {
  for (const broken of [{ ...entry(), authenticatedIntegrityVerified: false }, { ...entry(), metadataPresent: false }]) {
    const result = planStartupRecovery(recovery([broken]), now, 1_000);
    assert.equal(result.actions[0]?.action, 'quarantine-corrupt');
    assert.equal(result.actions[0]?.searchable, false);
    assert.deepEqual(result.actions[0]?.files, broken.bundle.files);
    assert.equal(result.gaps[0]?.reason, 'corrupt-media');
  }
});

test('a durably acknowledged in-place quarantine stays unavailable without blocking capture forever', () => {
  const quarantined = { ...entry(), authenticatedIntegrityVerified: false, quarantined: true };
  const result = planStartupRecovery(recovery([quarantined]), now, 1_000);
  assert.equal(result.actions[0]?.action, 'keep');
  assert.equal(result.actions[0]?.searchable, false);
  assert.equal(result.captureMustRemainStopped, false);
  assert.equal(result.gaps[0]?.availability, 'unavailable');
  assert.deepEqual(result, planStartupRecovery(recovery([quarantined]), now, 1_000));
});

test('future, corrupt, oversized, mismatched and unsafe recovery entries fail closed without action targets', () => {
  const unsafe = entry();
  unsafe.bundle = { ...unsafe.bundle, files: [{ ...unsafe.bundle.files[0]!, relativePath: '/outside/home-video' }] };
  for (const broken of [
    { ...entry(), endMs: now + 1 }, { ...entry(), endMs: 9_000 }, { ...entry(), startMs: 8_000 },
    { ...entry(), endMs: 9_999 }, { ...entry(), phase: 'writing' as const },
    { ...entry(), bundle: { ...bundle('segment'), files: [bundle('segment').files[0]!] } }, unsafe,
  ]) {
    const result = planStartupRecovery(recovery([entry('good'), broken]), now, 600);
    assert.equal(result.valid, false);
    assert.equal(result.captureMustRemainStopped, true);
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.gaps, []);
  }
});

test('incomplete scans, symlink uncertainty, duplicate entries, overflow and foreign namespaces block recovery', () => {
  const giant = entry('giant');
  giant.bundle = { ...giant.bundle, files: giant.bundle.files.map((file) => file.role === 'media'
    ? { ...file, byteLength: Number.MAX_SAFE_INTEGER - 2 } : file) };
  for (const scan of [
    { ...recovery([entry()]), namespace: 'outside' as typeof CACHE_NAMESPACE },
    { ...recovery([entry()]), complete: false },
    { ...recovery([entry()]), applicationOwned: false },
    { ...recovery([entry()]), rootAndAncestorsAreSymlinkFree: false },
    recovery([entry(), entry()]), recovery(Array(MAX_CACHE_RECORDS + 1).fill(entry())), recovery([giant, entry('extra')]),
  ]) assert.equal(planStartupRecovery(scan, now, 1_000).valid, false);
  assert.equal(planStartupRecovery(recovery([entry()]), NaN, 1_000).valid, false);
});

test('NAS outage permits only an already bounded local spool with no growth in configured cap', () => {
  const scan = inventory([bundle('existing', 2 * GB)]);
  const offline = planLocalSpoolWrite(scan, spoolPolicy, now, disk, proposed, false);
  const online = planLocalSpoolWrite(scan, spoolPolicy, now, disk, proposed, true);
  assert.equal(offline.captureAllowed, true);
  assert.equal(offline.destination, 'bounded-local-spool');
  assert.equal(offline.nasAvailable, false);
  assert.deepEqual(offline.gaps, []);
  assert.deepEqual(offline.retentionPreview, online.retentionPreview);
  assert.equal(offline.retentionPreview?.projectedBytesAfterWrite, 3 * GB);
});

test('at the local cap capture stops and marks a gap; no automatic deletion policy is applied', () => {
  const scan = inventory([bundle('unarchived', 20 * GB)]);
  const before = JSON.stringify(scan);
  const result = planLocalSpoolWrite(scan, spoolPolicy, now, disk, proposed, false);
  assert.equal(result.captureAllowed, false);
  assert.equal(result.stoppedReason, 'spool-quota-or-age');
  assert.equal(result.retentionPreview?.deletions[0]?.id, 'unarchived');
  assert.equal(result.gaps[0]?.availability, 'unavailable');
  assert.equal(JSON.stringify(scan), before);
});

test('exactly fitting the cap works; transfer duplication, logs and temporary files count toward it', () => {
  const exact = planLocalSpoolWrite(inventory([bundle('existing', 19 * GB)]), spoolPolicy, now, disk, proposed, false);
  assert.equal(exact.captureAllowed, true);
  assert.equal(exact.retentionPreview?.projectedBytesAfterWrite, 20 * GB);
  const duplicated = planLocalSpoolWrite(inventory([bundle('existing', 19 * GB)]), spoolPolicy, now, disk,
    { ...proposed, maximumBytes: 2 * GB }, false);
  assert.equal(duplicated.captureAllowed, false);
  const logs = planLocalSpoolWrite(inventory([bundle('existing', 18 * GB), bundle('log', GB, 'log'), bundle('tmp', GB, 'temporary')]), spoolPolicy, now, disk, proposed, false);
  assert.equal(logs.captureAllowed, false);
});

test('free disk reserve stops before allocating even when eviction could hypothetically reclaim bytes', () => {
  for (const scan of [inventory(), inventory([bundle('existing', 2 * GB)])]) {
    const result = planLocalSpoolWrite(scan, spoolPolicy, now, { ...disk, freeBytes: 10 * GB }, proposed, false);
    assert.equal(result.captureAllowed, false);
    assert.equal(result.stoppedReason, 'disk-reserve');
    assert.equal(result.gaps[0]?.reason, 'disk-reserve');
  }
});

test('expired local spool requires reconciliation and explicit eviction rather than silently keeping stale data', () => {
  const result = planLocalSpoolWrite(inventory([bundle('expired', GB, 'capture', 1_000)]),
    { ...spoolPolicy, maxAgeMs: 2_000 }, now, disk, proposed, false);
  assert.equal(result.captureAllowed, false);
  assert.equal(result.retentionPreview?.deletions[0]?.reason, 'expired');
});

test('draft local spool is 20 decimal GB and every policy above the hard 50GB ceiling is rejected', () => {
  assert.equal(DRAFT_LOCAL_SPOOL_MAX_BYTES, 20 * GB);
  assert.equal(HARD_LOCAL_SPOOL_MAX_BYTES, 50 * GB);
  assert.equal(planLocalSpoolWrite(inventory(), { ...spoolPolicy, maxBytes: 50 * GB }, now, disk, proposed, false).valid, true);
  for (const maxBytes of [50 * GB + 1, Infinity, Number.MAX_SAFE_INTEGER]) {
    const result = planLocalSpoolWrite(inventory(), { ...spoolPolicy, maxBytes }, now, disk, proposed, true);
    assert.equal(result.valid, false);
    assert.equal(result.captureAllowed, false);
    assert.equal(result.retentionPreview, null);
  }
});

test('unbounded/oversized segments, impossible disk facts and corrupt inventories stop the spool', () => {
  for (const proposal of [
    { ...proposed, maximumBytes: 2 * GB + 1 }, { ...proposed, maximumBytes: NaN },
    { ...proposed, startMs: now + 1 }, { ...proposed, endMs: now + 1_001 },
    { ...proposed, startMs: now - 1_001, endMs: now - 1_000 },
  ]) assert.equal(planLocalSpoolWrite(inventory(), spoolPolicy, now, disk, proposal, false).valid, false);
  assert.equal(planLocalSpoolWrite(inventory(), spoolPolicy, now, { ...disk, inventoryOnSameVolume: false }, proposed, false).valid, false);
  const corrupt = planLocalSpoolWrite({ ...inventory(), complete: false }, spoolPolicy, now, disk, proposed, false);
  assert.equal(corrupt.valid, false);
  assert.equal(corrupt.gaps[0]?.reason, 'invalid-spool-state');
  assert.equal(planLocalSpoolWrite(inventory(), { ...spoolPolicy, minFreeDiskBytes: 0 }, now, disk, proposed, false).valid, false);
});
