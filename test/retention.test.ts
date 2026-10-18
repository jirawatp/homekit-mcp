import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CACHE_NAMESPACE, MAX_CACHE_RECORDS, planRetention,
  type CacheKind, type CacheRecord, type DiskState, type PendingWrite,
  type RetentionInventory, type RetentionPolicy,
} from '../src/retention.js';

// Tiny synthetic byte/time units exercise logic; none of these is an active policy.
const now = 10_000;
const policy: RetentionPolicy = {
  maxAgeMs: 1_000, maxTotalBytes: 1_000,
  maxTemporaryAgeMs: 100, maxTemporaryBytes: 100,
  maxLogAgeMs: 200, maxLogBytes: 100, minFreeDiskBytes: 500,
};
const disk: DiskState = { freeBytes: 5_000, totalBytes: 10_000, inventoryOnSameVolume: true };
const pending: PendingWrite = { kind: 'capture', maximumBytes: 1 };
const dirs: Record<CacheKind, string> = { capture: 'captures', temporary: 'temporary', log: 'logs' };
function record(id: string, age: number, bytes: number, kind: CacheKind = 'capture'): CacheRecord {
  return {
    id, kind, createdAtMs: now - age,
    files: [{ relativePath: `${dirs[kind]}/${id}/data.bin`, byteLength: bytes,
      role: kind === 'capture' ? 'media' : kind, regularFile: true, symlinkFreePath: true }],
  };
}
function inventory(records: readonly CacheRecord[]): RetentionInventory {
  return { namespace: CACHE_NAMESPACE, applicationOwned: true, complete: true, rootAndAncestorsAreSymlinkFree: true, records };
}
const ids = (plan: ReturnType<typeof planRetention>): string[] => plan.deletions.map((bundle) => bundle.id);

test('retention age boundary evicts the whole bundle including thumbnail, index and metadata', () => {
  const old = record('old', 1_000, 30);
  old.files = [...old.files, ...(['thumbnail', 'index', 'metadata'] as const).map((role) => ({
    relativePath: `captures/old/${role}.bin`, byteLength: 10, role, regularFile: true, symlinkFreePath: true,
  }))];
  const result = planRetention(inventory([record('new', 999, 20), old]), policy, now, disk, pending);
  assert.deepEqual(ids(result), ['old']);
  assert.equal(result.deletions[0]?.files.length, 4);
  assert.equal(result.reclaimedBytes, 60);
  assert.equal(result.deletions[0]?.reason, 'expired');
  assert.equal(result.allowCapture, true);
});

test('total quota evicts oldest first regardless of inventory order, including pending budget', () => {
  const result = planRetention(inventory([record('new', 10, 400), record('old', 500, 400), record('middle', 100, 400)]), policy, now, disk, { kind: 'capture', maximumBytes: 250 });
  assert.deepEqual(ids(result), ['old', 'middle']);
  assert.equal(result.projectedBytesAfterWrite, 650);
  assert.equal(result.deletions[0]?.reason, 'total-quota');
});

test('temporary files and logs have independent age and byte bounds included in total bytes', () => {
  const result = planRetention(inventory([
    record('t-expired', 100, 10, 'temporary'), record('t-old', 90, 70, 'temporary'), record('t-new', 10, 70, 'temporary'),
    record('l-expired', 200, 10, 'log'), record('l-old', 190, 70, 'log'), record('l-new', 10, 70, 'log'), record('media', 500, 10),
  ]), policy, now, disk, pending);
  assert.deepEqual(ids(result), ['l-expired', 'l-old', 't-expired', 't-old']);
  assert.equal(result.retainedBytes, 150);
  assert.equal(result.deletions.find((entry) => entry.id === 't-old')?.reason, 'temporary-quota');
  assert.equal(result.deletions.find((entry) => entry.id === 'l-old')?.reason, 'log-quota');
});

test('pending temporary and log writes reserve their own subquota before capture is allowed', () => {
  for (const kind of ['temporary', 'log'] as const) {
    const result = planRetention(inventory([record('old', 1, 70, kind)]), policy, now, disk, { kind, maximumBytes: 40 });
    assert.deepEqual(ids(result), ['old']);
    assert.equal(result.allowCapture, true);
  }
});

test('free disk reserve triggers oldest-first reclamation even below total quota', () => {
  const result = planRetention(inventory([record('new', 1, 200), record('old', 2, 300)]), policy, now,
    { ...disk, freeBytes: 400 }, { kind: 'capture', maximumBytes: 100 });
  assert.deepEqual(ids(result), ['old']);
  assert.equal(result.deletions[0]?.reason, 'disk-reserve');
  assert.equal(result.projectedFreeBytesAfterWrite, 600);
});

test('capture stops when even removing every owned record cannot preserve disk reserve', () => {
  const result = planRetention(inventory([record('only', 1, 100)]), policy, now,
    { ...disk, freeBytes: 100 }, { kind: 'capture', maximumBytes: 100 });
  assert.equal(result.allowCapture, false);
  assert.equal(result.stoppedReason, 'insufficient-disk-reserve');
  assert.deepEqual(ids(result), ['only']);
});

test('an impossible pending write stops without evicting otherwise valid records to make room', () => {
  for (const write of [{ kind: 'capture', maximumBytes: 1_001 }, { kind: 'log', maximumBytes: 101 }] as const) {
    const result = planRetention(inventory([record('keep', 1, 100)]), policy, now, disk, write);
    assert.equal(result.stoppedReason, 'pending-write-exceeds-quota');
    assert.deepEqual(result.deletions, []);
  }
});

test('no write budget means capture is stopped while cleanup can still be previewed', () => {
  const result = planRetention(inventory([record('old', 2_000, 100)]), policy, now, disk);
  assert.deepEqual(ids(result), ['old']);
  assert.equal(result.stoppedReason, 'pending-write-budget-required');
  assert.equal(result.allowCapture, false);
});

test('future or corrupt records fail closed with no deletion plan', () => {
  for (const bad of [
    { ...record('bad', 1, 10), createdAtMs: now + 1 },
    { ...record('bad', 1, 10), createdAtMs: NaN },
    { ...record('bad', 1, 10), files: [] },
    { ...record('bad', 1, 10), id: '../outside' },
  ]) {
    const result = planRetention(inventory([record('expired', 2_000, 20), bad]), policy, now, disk, pending);
    assert.equal(result.valid, false);
    assert.equal(result.allowCapture, false);
    assert.equal(result.stoppedReason, 'invalid-inventory');
    assert.deepEqual(result.deletions, []);
  }
});

test('absolute, traversal, foreign-bundle, encoded, nested and Windows paths cannot be deletion targets', () => {
  for (const relativePath of ['/tmp/data', 'captures/bad/../outside', 'captures/other/file', 'captures/bad/%2e%2e', 'captures/bad/sub/file', 'C:\\outside', 'captures/bad/a\u0000b']) {
    const bad = record('bad', 2_000, 20);
    bad.files = [{ ...bad.files[0]!, relativePath }];
    const result = planRetention(inventory([bad]), policy, now, disk, pending);
    assert.equal(result.valid, false, relativePath);
    assert.deepEqual(result.deletions, []);
  }
});

test('symlinks, special files, unverified ancestors, foreign namespace and incomplete scans fail closed', () => {
  const original = record('bad', 2_000, 20);
  const scans: RetentionInventory[] = [
    { ...inventory([original]), namespace: 'foreign' as typeof CACHE_NAMESPACE },
    { ...inventory([original]), complete: false },
    { ...inventory([original]), applicationOwned: false },
    { ...inventory([original]), rootAndAncestorsAreSymlinkFree: false },
    inventory([{ ...original, files: [{ ...original.files[0]!, symlinkFreePath: false }] }]),
    inventory([{ ...original, files: [{ ...original.files[0]!, regularFile: false }] }]),
  ];
  for (const scan of scans) {
    const result = planRetention(scan, policy, now, disk, pending);
    assert.equal(result.stoppedReason, 'invalid-inventory');
    assert.deepEqual(result.deletions, []);
  }
});

test('duplicate bundles and members and missing/multiple primary files are invalid', () => {
  const single = record('bad', 1, 10);
  for (const records of [
    [single, single],
    [{ ...single, files: [...single.files, ...single.files] }],
    [{ ...single, files: [{ ...single.files[0]!, role: 'metadata' as const }] }],
    [{ ...single, files: [...single.files, { ...single.files[0]!, relativePath: 'captures/bad/second.bin' }] }],
  ]) assert.equal(planRetention(inventory(records), policy, now, disk, pending).valid, false);
});

test('integer overflow, huge inventories and large per-bundle lists are bounded', () => {
  const giant = record('giant', 1, Number.MAX_SAFE_INTEGER);
  const overflowing = { ...giant, files: [...giant.files, { relativePath: 'captures/giant/meta.bin', byteLength: 1, role: 'metadata' as const, regularFile: true, symlinkFreePath: true }] };
  for (const scan of [
    inventory([overflowing]), inventory([giant, record('plus', 1, 1)]),
    inventory(Array(MAX_CACHE_RECORDS + 1).fill(record('too-many', 1, 1))),
    inventory([{ ...giant, files: Array(17).fill(giant.files[0]!) }]),
  ]) assert.equal(planRetention(scan, policy, now, disk, pending).valid, false);
});

test('policy, clock, disk and pending input validation stop capture without deletions', () => {
  const scan = inventory([record('expired', 2_000, 1)]);
  for (const invalidPolicy of [{ ...policy, maxAgeMs: 0 }, { ...policy, maxTotalBytes: Infinity }, { ...policy, maxTemporaryBytes: 1_001 }, { ...policy, minFreeDiskBytes: 0 }]) {
    const result = planRetention(scan, invalidPolicy, now, disk, pending);
    assert.equal(result.stoppedReason, 'invalid-policy'); assert.deepEqual(result.deletions, []);
  }
  assert.equal(planRetention(scan, policy, NaN, disk, pending).stoppedReason, 'invalid-clock');
  for (const badDisk of [{ ...disk, inventoryOnSameVolume: false }, { ...disk, freeBytes: 10_001 }, { ...disk, freeBytes: 10_000 }]) {
    assert.equal(planRetention(scan, policy, now, badDisk, pending).stoppedReason, 'invalid-disk');
  }
  for (const maximumBytes of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(planRetention(scan, policy, now, disk, { kind: 'capture', maximumBytes }).stoppedReason, 'invalid-pending-write');
  }
});

test('planner is deterministic and does not mutate inventory, policy or caller-owned arrays', () => {
  const scan = inventory([record('z', 2_000, 10), record('a', 2_000, 10)]);
  const before = JSON.stringify({ scan, policy, disk, pending });
  const first = planRetention(scan, policy, now, disk, pending);
  const second = planRetention(scan, policy, now, disk, pending);
  assert.deepEqual(first, second);
  assert.deepEqual(ids(first), ['a', 'z']);
  assert.equal(JSON.stringify({ scan, policy, disk, pending }), before);
  first.deletions[0]!.files[0]!.relativePath = 'changed-result';
  assert.equal(scan.records[1]!.files[0]!.relativePath, 'captures/a/data.bin');
});
