/** Pure, mock-only planning. This module never accesses or deletes files. */
export const CACHE_NAMESPACE = 'homekit-mcp-cache-v1' as const;
export const MAX_CACHE_RECORDS = 10_000;
export const MAX_FILES_PER_BUNDLE = 16;

export type CacheKind = 'capture' | 'temporary' | 'log';
export type CacheFileRole = 'media' | 'thumbnail' | 'index' | 'metadata' | 'temporary' | 'log';

export interface OwnedCacheFile {
  /** Exactly <captures|temporary|logs>/<bundle-id>/<filename>; never an OS path. */
  relativePath: string;
  byteLength: number;
  role: CacheFileRole;
  regularFile: boolean;
  /** A future executor must establish this for the file AND every path ancestor. */
  symlinkFreePath: boolean;
}

export interface CacheRecord {
  id: string;
  kind: CacheKind;
  createdAtMs: number;
  /** All media, thumbnails, per-segment index and metadata form ONE deletion unit. */
  files: readonly OwnedCacheFile[];
}

export interface RetentionInventory {
  namespace: typeof CACHE_NAMESPACE;
  applicationOwned: boolean;
  complete: boolean;
  rootAndAncestorsAreSymlinkFree: boolean;
  records: readonly CacheRecord[];
}

/** Required explicit values. There is deliberately no default retention policy. */
export interface RetentionPolicy {
  maxAgeMs: number;
  maxTotalBytes: number;
  maxTemporaryAgeMs: number;
  maxTemporaryBytes: number;
  maxLogAgeMs: number;
  maxLogBytes: number;
  minFreeDiskBytes: number;
}

export interface DiskState {
  freeBytes: number;
  totalBytes: number;
  /** Reclaimed bytes count only if cache and prospective write share this volume. */
  inventoryOnSameVolume: boolean;
}

export interface PendingWrite {
  kind: CacheKind;
  /** Upper bound including encryption overhead, sidecars and staging duplication. */
  maximumBytes: number;
}

export type DeletionReason = 'expired' | 'temporary-quota' | 'log-quota' | 'total-quota' | 'disk-reserve';
export interface DeletionBundle {
  id: string;
  kind: CacheKind;
  files: readonly OwnedCacheFile[];
  byteLength: number;
  reason: DeletionReason;
}

export type RetentionStopReason =
  | 'invalid-policy' | 'invalid-clock' | 'invalid-inventory' | 'invalid-disk'
  | 'invalid-pending-write' | 'pending-write-budget-required'
  | 'pending-write-exceeds-quota' | 'insufficient-disk-reserve';

export interface RetentionPlan {
  namespace: typeof CACHE_NAMESPACE;
  valid: boolean;
  /** Only a plan: authorization, revalidation and confirmed deletion are still required. */
  deletions: readonly DeletionBundle[];
  allowCapture: boolean;
  stoppedReason: RetentionStopReason | null;
  diagnostics: readonly string[];
  currentBytes: number | null;
  retainedBytes: number | null;
  reclaimedBytes: number | null;
  projectedBytesAfterWrite: number | null;
  projectedFreeBytesAfterWrite: number | null;
}

const directories: Record<CacheKind, string> = { capture: 'captures', temporary: 'temporary', log: 'logs' };
const allowedRoles: Record<CacheKind, readonly CacheFileRole[]> = {
  capture: ['media', 'thumbnail', 'index', 'metadata'],
  temporary: ['temporary', 'metadata'],
  log: ['log', 'metadata'],
};
const primaryRoles: Record<CacheKind, CacheFileRole> = { capture: 'media', temporary: 'temporary', log: 'log' };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;
const kindValid = (value: unknown): value is CacheKind => value === 'capture' || value === 'temporary' || value === 'log';
const addSafe = (a: number, b: number): number | null => Number.isSafeInteger(a + b) ? a + b : null;

/** Runtime validation is shared by recovery's synthetic manifests. No filesystem proof is inferred. */
export function validateCacheRecord(record: unknown, nowMs: number): string | null {
  if (!object(record) || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(record.id)) return 'Invalid bundle identifier.';
  if (!kindValid(record.kind)) return 'Invalid bundle kind.';
  if (!natural(record.createdAtMs) || record.createdAtMs > nowMs) return 'Invalid or future bundle timestamp.';
  if (!Array.isArray(record.files) || record.files.length === 0 || record.files.length > MAX_FILES_PER_BUNDLE) return 'Invalid or oversized bundle file list.';
  let bytes = 0;
  let primaryCount = 0;
  const seen = new Set<string>();
  const prefix = `${directories[record.kind]}/${record.id}/`;
  for (const file of record.files) {
    if (!object(file) || typeof file.relativePath !== 'string' || file.relativePath.length > 256) return 'Invalid cache member path.';
    if (!file.relativePath.startsWith(prefix)) return 'Cache member is outside its owned bundle.';
    const name = file.relativePath.slice(prefix.length);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || name === '.' || name === '..') return 'Unsafe cache member filename.';
    if (file.regularFile !== true || file.symlinkFreePath !== true) return 'Cache member is not a verified symlink-free regular file.';
    if (!natural(file.byteLength)) return 'Invalid cache member byte length.';
    if (!allowedRoles[record.kind].includes(file.role as CacheFileRole)) return 'Invalid member role for its bundle.';
    if (seen.has(file.relativePath)) return 'Duplicate cache member path.';
    seen.add(file.relativePath);
    if (file.role === primaryRoles[record.kind]) primaryCount += 1;
    const total = addSafe(bytes, file.byteLength);
    if (total === null) return 'Cache member byte total overflow.';
    bytes = total;
  }
  if (primaryCount !== 1 || bytes === 0) return 'Each nonempty bundle needs exactly one primary file.';
  return null;
}

function invalid(reason: RetentionStopReason, detail: string): RetentionPlan {
  return {
    namespace: CACHE_NAMESPACE, valid: false, deletions: [], allowCapture: false,
    stoppedReason: reason, diagnostics: [detail], currentBytes: null, retainedBytes: null,
    reclaimedBytes: null, projectedBytesAfterWrite: null, projectedFreeBytesAfterWrite: null,
  };
}

/**
 * Calculate oldest-first eviction of complete owned bundles under age, byte and
 * free-space bounds. Uncertain/corrupt input fails closed with NO deletions.
 * A future executor must re-read disk state and inventory after actual eviction;
 * planned reclaimed bytes are not evidence that capacity is already available.
 */
export function planRetention(
  inventory: RetentionInventory,
  policy: RetentionPolicy,
  nowMs: number,
  disk: DiskState,
  pending?: PendingWrite,
): RetentionPlan {
  if (!natural(nowMs)) return invalid('invalid-clock', 'Clock must be a nonnegative safe-integer timestamp.');
  if (!object(policy) || !positive(policy.maxAgeMs) || !positive(policy.maxTotalBytes)
      || !positive(policy.maxTemporaryAgeMs) || !positive(policy.maxTemporaryBytes)
      || !positive(policy.maxLogAgeMs) || !positive(policy.maxLogBytes) || !positive(policy.minFreeDiskBytes)
      || policy.maxTemporaryBytes > policy.maxTotalBytes || policy.maxLogBytes > policy.maxTotalBytes) {
    return invalid('invalid-policy', 'Every age and quota must be explicit, finite and bounded; subquotas cannot exceed the total.');
  }
  if (!object(inventory) || inventory.namespace !== CACHE_NAMESPACE || inventory.applicationOwned !== true
      || inventory.complete !== true || inventory.rootAndAncestorsAreSymlinkFree !== true
      || !Array.isArray(inventory.records) || inventory.records.length > MAX_CACHE_RECORDS) {
    return invalid('invalid-inventory', 'A complete bounded inventory of the verified application-owned namespace is required.');
  }
  const ids = new Set<string>();
  const entries: { record: CacheRecord; bytes: number }[] = [];
  let currentBytes = 0;
  for (const record of inventory.records) {
    const error = validateCacheRecord(record, nowMs);
    if (error) return invalid('invalid-inventory', error);
    if (ids.has(record.id)) return invalid('invalid-inventory', 'Duplicate cache bundle identifier.');
    ids.add(record.id);
    const bytes = record.files.reduce((total: number, file: OwnedCacheFile) => total + file.byteLength, 0);
    const next = addSafe(currentBytes, bytes);
    if (next === null) return invalid('invalid-inventory', 'Cache inventory byte total overflow.');
    currentBytes = next;
    entries.push({ record, bytes });
  }
  if (!object(disk) || !natural(disk.freeBytes) || !positive(disk.totalBytes) || disk.freeBytes > disk.totalBytes
      || currentBytes > disk.totalBytes - disk.freeBytes || disk.inventoryOnSameVolume !== true
      || policy.minFreeDiskBytes > disk.totalBytes) {
    return invalid('invalid-disk', 'Disk state must describe this cache volume, consistent capacity and the configured reserve.');
  }
  if (pending !== undefined && (!object(pending) || !kindValid(pending.kind) || !positive(pending.maximumBytes))) {
    return invalid('invalid-pending-write', 'A prospective write requires an explicit positive safe-integer maximum byte budget.');
  }
  const pendingBytes = pending?.maximumBytes ?? 0;
  const kindQuota = pending?.kind === 'temporary' ? policy.maxTemporaryBytes
    : pending?.kind === 'log' ? policy.maxLogBytes : policy.maxTotalBytes;
  const pendingCanFitQuota = pendingBytes <= policy.maxTotalBytes && pendingBytes <= kindQuota;
  // Impossible writes must not cause additional eviction of otherwise valid data.
  const reservation = pendingCanFitQuota ? pendingBytes : 0;
  entries.sort((a, b) => a.record.createdAtMs - b.record.createdAtMs || a.record.id.localeCompare(b.record.id, 'en'));
  const selected = new Map<string, DeletionReason>();
  let retainedBytes = currentBytes;
  let reclaimedBytes = 0;
  const byKind: Record<CacheKind, number> = { capture: 0, temporary: 0, log: 0 };
  for (const entry of entries) byKind[entry.record.kind] += entry.bytes;
  const select = (entry: { record: CacheRecord; bytes: number }, reason: DeletionReason): void => {
    if (selected.has(entry.record.id)) return;
    selected.set(entry.record.id, reason);
    retainedBytes -= entry.bytes;
    reclaimedBytes += entry.bytes;
    byKind[entry.record.kind] -= entry.bytes;
  };
  for (const entry of entries) {
    const ageBound = entry.record.kind === 'temporary' ? policy.maxTemporaryAgeMs
      : entry.record.kind === 'log' ? policy.maxLogAgeMs : policy.maxAgeMs;
    if (nowMs - entry.record.createdAtMs >= ageBound) select(entry, 'expired');
  }
  for (const kind of ['temporary', 'log'] as const) {
    const quota = kind === 'temporary' ? policy.maxTemporaryBytes : policy.maxLogBytes;
    const reserved = pending?.kind === kind ? reservation : 0;
    for (const entry of entries) {
      if (byKind[kind] <= quota - reserved) break;
      if (entry.record.kind === kind) select(entry, kind === 'temporary' ? 'temporary-quota' : 'log-quota');
    }
  }
  for (const entry of entries) {
    if (retainedBytes <= policy.maxTotalBytes - reservation) break;
    select(entry, 'total-quota');
  }
  for (const entry of entries) {
    // Subtraction avoids overflowing reserve + pendingBytes.
    if (disk.freeBytes + reclaimedBytes - reservation >= policy.minFreeDiskBytes) break;
    select(entry, 'disk-reserve');
  }
  const projectedBytesAfterWrite = pendingCanFitQuota ? addSafe(retainedBytes, pendingBytes) : null;
  const projectedFreeBytesAfterWrite = pendingCanFitQuota ? disk.freeBytes + reclaimedBytes - pendingBytes : null;
  let stoppedReason: RetentionStopReason | null = null;
  if (!pending) stoppedReason = 'pending-write-budget-required';
  else if (!pendingCanFitQuota) stoppedReason = 'pending-write-exceeds-quota';
  else if (projectedFreeBytesAfterWrite === null || projectedFreeBytesAfterWrite < policy.minFreeDiskBytes) stoppedReason = 'insufficient-disk-reserve';
  const deletions: DeletionBundle[] = entries.flatMap(({ record, bytes }) => {
    const reason = selected.get(record.id);
    return reason ? [{ id: record.id, kind: record.kind, byteLength: bytes, reason, files: record.files.map((file) => ({ ...file })) }] : [];
  });
  return {
    namespace: CACHE_NAMESPACE, valid: true, deletions,
    allowCapture: stoppedReason === null, stoppedReason,
    diagnostics: deletions.length ? ['Reclaimed capacity is projected; confirm eviction and replan before writing.'] : [],
    currentBytes, retainedBytes, reclaimedBytes, projectedBytesAfterWrite, projectedFreeBytesAfterWrite,
  };
}
