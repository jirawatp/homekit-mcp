/** Synthetic crash/outage planners. No filesystem, camera, NAS or cloud operations. */
import {
  CACHE_NAMESPACE, MAX_CACHE_RECORDS, planRetention, validateCacheRecord,
  type CacheRecord, type DiskState, type OwnedCacheFile, type RetentionInventory,
} from './retention.js';

/** Decimal GB. A draft planning value, never an allocation or an enabled policy. */
export const DRAFT_LOCAL_SPOOL_MAX_BYTES = 20_000_000_000;
export const HARD_LOCAL_SPOOL_MAX_BYTES = 50_000_000_000;

export const SEGMENT_COMMIT_PROTOCOL = [
  'reserve-total-peak-bytes-including-sidecars-and-upload-staging',
  'write-short-authenticated-encrypted-segment-to-private-local-temporary-bundle',
  'flush-files-and-verify-authenticated-media-and-manifest',
  'atomic-rename-whole-bundle-on-the-same-local-filesystem',
  'flush-containing-directory',
  'commit-local-index-transaction',
  'publish-searchable-segment',
] as const;

export interface RecoveryEntry {
  /** Manifest references expected members; media/index can be absent after a crash. */
  bundle: CacheRecord;
  phase: 'writing' | 'finalized';
  startMs: number;
  endMs: number;
  mediaPresent: boolean;
  indexPresent: boolean;
  metadataPresent: boolean;
  authenticatedIntegrityVerified: boolean;
  /** Durable unavailable flag; an acknowledged in-place quarantine is not repeated. */
  quarantined: boolean;
}

export interface RecoveryInventory {
  namespace: typeof CACHE_NAMESPACE;
  applicationOwned: boolean;
  complete: boolean;
  rootAndAncestorsAreSymlinkFree: boolean;
  entries: readonly RecoveryEntry[];
}

export interface CoverageGap {
  startMs: number;
  endMs: number;
  reason: 'power-loss-incomplete' | 'missing-media' | 'corrupt-media' | 'spool-quota-or-age' | 'disk-reserve' | 'invalid-spool-state';
  /** Honest unavailable interval. This never means no person/event was present. */
  availability: 'unavailable';
}

export interface RecoveryAction {
  id: string;
  action: 'discard-incomplete' | 'rebuild-index' | 'remove-dangling-index-and-sidecars' | 'quarantine-corrupt' | 'keep';
  files: readonly OwnedCacheFile[];
  /** Never expose incomplete/corrupt/missing-media segments in history search. */
  searchable: boolean;
}

export interface RecoveryPlan {
  valid: boolean;
  captureMustRemainStopped: boolean;
  actions: readonly RecoveryAction[];
  gaps: readonly CoverageGap[];
  diagnostics: readonly string[];
}

const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function unsafeRecovery(detail: string): RecoveryPlan {
  return { valid: false, captureMustRemainStopped: true, actions: [], gaps: [], diagnostics: [detail] };
}

/** Reconcile synthetic manifests without guessing that an interrupted segment is valid. */
export function planStartupRecovery(inventory: RecoveryInventory, nowMs: number, maxSegmentDurationMs: number): RecoveryPlan {
  if (!natural(nowMs) || !positive(maxSegmentDurationMs)) return unsafeRecovery('Invalid clock or maximum short-segment duration.');
  if (!object(inventory) || inventory.namespace !== CACHE_NAMESPACE || inventory.applicationOwned !== true
      || inventory.complete !== true || inventory.rootAndAncestorsAreSymlinkFree !== true
      || !Array.isArray(inventory.entries) || inventory.entries.length > MAX_CACHE_RECORDS) {
    return unsafeRecovery('Recovery requires a complete bounded inventory of the verified application-owned namespace.');
  }
  const entries: RecoveryEntry[] = [];
  const seen = new Set<string>();
  let totalManifestBytes = 0;
  for (const candidate of inventory.entries as readonly unknown[]) {
    if (!object(candidate)) return unsafeRecovery('Invalid recovery entry.');
    const error = validateCacheRecord(candidate.bundle, nowMs);
    if (error) return unsafeRecovery(error);
    const entry = candidate as unknown as RecoveryEntry;
    for (const file of entry.bundle.files) {
      if (!Number.isSafeInteger(totalManifestBytes + file.byteLength)) return unsafeRecovery('Recovery manifest byte total overflow.');
      totalManifestBytes += file.byteLength;
    }
    if (seen.has(entry.bundle.id)) return unsafeRecovery('Duplicate recovery bundle identifier.');
    seen.add(entry.bundle.id);
    if ((entry.phase !== 'writing' && entry.phase !== 'finalized')
        || !natural(entry.startMs) || !natural(entry.endMs) || entry.endMs <= entry.startMs
        || entry.endMs > nowMs || entry.startMs !== entry.bundle.createdAtMs
        || entry.endMs - entry.startMs > maxSegmentDurationMs
        || typeof entry.mediaPresent !== 'boolean' || typeof entry.indexPresent !== 'boolean'
        || typeof entry.metadataPresent !== 'boolean' || typeof entry.authenticatedIntegrityVerified !== 'boolean'
        || typeof entry.quarantined !== 'boolean') {
      return unsafeRecovery('Invalid, future or oversized recovery segment, or unknown integrity facts.');
    }
    if (entry.phase === 'writing' && (entry.bundle.kind !== 'temporary' || entry.quarantined)) return unsafeRecovery('An unfinished segment must remain in its owned temporary bundle.');
    if (entry.phase === 'finalized' && (entry.bundle.kind !== 'capture'
        || entry.bundle.files.filter((file) => file.role === 'metadata').length !== 1
        || entry.bundle.files.filter((file) => file.role === 'index').length !== 1)) {
      return unsafeRecovery('A finalized segment requires capture media and exactly one authenticated metadata/index descriptor.');
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.startMs - b.startMs || a.bundle.id.localeCompare(b.bundle.id, 'en'));
  const actions: RecoveryAction[] = [];
  const gaps: CoverageGap[] = [];
  for (const entry of entries) {
    let action: RecoveryAction['action'] = 'keep';
    let searchable = false;
    let files = entry.bundle.files.map((file) => ({ ...file }));
    if (entry.phase === 'writing') {
      action = 'discard-incomplete';
      gaps.push({ startMs: entry.startMs, endMs: nowMs, reason: 'power-loss-incomplete', availability: 'unavailable' });
    } else if (!entry.mediaPresent) {
      action = 'remove-dangling-index-and-sidecars';
      files = files.filter((file) => file.role !== 'media' && (file.role !== 'index' || entry.indexPresent)
        && (file.role !== 'metadata' || entry.metadataPresent));
      gaps.push({ startMs: entry.startMs, endMs: entry.endMs, reason: 'missing-media', availability: 'unavailable' });
    } else if (entry.quarantined) {
      gaps.push({ startMs: entry.startMs, endMs: entry.endMs, reason: 'corrupt-media', availability: 'unavailable' });
    } else if (!entry.authenticatedIntegrityVerified || !entry.metadataPresent) {
      // A quarantine is an in-place unavailable flag; it must NOT duplicate media or bypass quotas.
      action = 'quarantine-corrupt';
      gaps.push({ startMs: entry.startMs, endMs: entry.endMs, reason: 'corrupt-media', availability: 'unavailable' });
    } else if (!entry.indexPresent) {
      action = 'rebuild-index';
    } else searchable = true;
    actions.push({ id: entry.bundle.id, action, files, searchable });
  }
  return {
    valid: true, captureMustRemainStopped: actions.some((action) => action.action !== 'keep'), actions, gaps,
    diagnostics: ['Plans are unexecuted. Reconcile and re-inventory before capture; publish only authenticated finalized and indexed segments.'],
  };
}

export interface LocalSpoolPolicy {
  maxBytes: number;
  maxAgeMs: number;
  minFreeDiskBytes: number;
  maxSegmentBytes: number;
  maxSegmentDurationMs: number;
}
export interface ProposedSegment {
  startMs: number;
  endMs: number;
  /** Peak bytes: encrypted segment + sidecars + temporary/transfer duplication. */
  maximumBytes: number;
}
export interface LocalSpoolPlan {
  valid: boolean;
  captureAllowed: boolean;
  nasAvailable: boolean;
  destination: 'bounded-local-spool';
  stoppedReason: 'invalid-spool-state' | 'spool-quota-or-age' | 'disk-reserve' | null;
  gaps: readonly CoverageGap[];
  /** Preview only. Existing unarchived data is never automatically evicted here. */
  retentionPreview: ReturnType<typeof planRetention> | null;
}

/**
 * Check capacity before any allocation. NAS availability never raises the Mac
 * quota. This function permits no automatic eviction or unbounded fallback.
 */
export function planLocalSpoolWrite(
  inventory: RetentionInventory,
  policy: LocalSpoolPolicy,
  nowMs: number,
  disk: DiskState,
  proposed: ProposedSegment,
  nasAvailable: boolean,
): LocalSpoolPlan {
  const base = { nasAvailable: nasAvailable === true, destination: 'bounded-local-spool' as const };
  const invalid = (): LocalSpoolPlan => ({ ...base, valid: false, captureAllowed: false,
    stoppedReason: 'invalid-spool-state', gaps: [], retentionPreview: null });
  if (!natural(nowMs) || typeof nasAvailable !== 'boolean' || !object(policy)
      || !positive(policy.maxBytes) || policy.maxBytes > HARD_LOCAL_SPOOL_MAX_BYTES
      || !positive(policy.maxAgeMs) || !positive(policy.minFreeDiskBytes)
      || !positive(policy.maxSegmentBytes) || policy.maxSegmentBytes > policy.maxBytes
      || !positive(policy.maxSegmentDurationMs) || policy.maxSegmentDurationMs > policy.maxAgeMs
      || !object(proposed) || !natural(proposed.startMs) || !natural(proposed.endMs)
      || proposed.endMs <= proposed.startMs || proposed.startMs > nowMs
      || nowMs - proposed.startMs > policy.maxSegmentDurationMs
      || proposed.endMs - proposed.startMs > policy.maxSegmentDurationMs
      || !positive(proposed.maximumBytes) || proposed.maximumBytes > policy.maxSegmentBytes) return invalid();
  const retentionPreview = planRetention(inventory, {
    maxAgeMs: policy.maxAgeMs, maxTotalBytes: policy.maxBytes,
    maxTemporaryAgeMs: policy.maxAgeMs, maxTemporaryBytes: policy.maxBytes,
    maxLogAgeMs: policy.maxAgeMs, maxLogBytes: policy.maxBytes,
    minFreeDiskBytes: policy.minFreeDiskBytes,
  }, nowMs, disk, { kind: 'capture', maximumBytes: proposed.maximumBytes });
  if (!retentionPreview.valid) return { ...invalid(), retentionPreview,
    gaps: [{ startMs: proposed.startMs, endMs: proposed.endMs, reason: 'invalid-spool-state', availability: 'unavailable' }] };
  let stoppedReason: LocalSpoolPlan['stoppedReason'] = null;
  if (retentionPreview.stoppedReason === 'insufficient-disk-reserve'
      || retentionPreview.deletions.some((deletion) => deletion.reason === 'disk-reserve')) stoppedReason = 'disk-reserve';
  else if (!retentionPreview.allowCapture || retentionPreview.deletions.length > 0) stoppedReason = 'spool-quota-or-age';
  return {
    ...base, valid: true, captureAllowed: stoppedReason === null, stoppedReason, retentionPreview,
    gaps: stoppedReason ? [{ startMs: proposed.startMs, endMs: proposed.endMs, reason: stoppedReason, availability: 'unavailable' }] : [],
  };
}
