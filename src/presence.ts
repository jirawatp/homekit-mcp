/** Anonymous sensor occupancy and consent-bound room presence. No camera access. */
export interface OccupancySignal {
  signalId: string;
  roomId: string;
  method: "occupancy-sensor" | "motion-sensor";
  state: "detected" | "not-detected" | "unknown";
  observedAt: string;
  simulated: boolean;
}

export interface PresenceOptions {
  now?: Date;
  maxAgeMs?: number;
}

export interface PresenceFreshness {
  evaluatedAt: string;
  observedAt: string | null;
  ageMs: number | null;
  maxAgeMs: number;
  state: "fresh" | "stale" | "unknown" | "clock-skew";
}

export interface RoomOccupancyResult {
  roomId: string;
  status: "occupied" | "unoccupied" | "unknown";
  reason: "sensor_detected" | "occupancy_sensor_clear" | "no_signals" | "stale_signals" | "motion_inactive_is_not_empty" | "unknown_signals" | "clock_skew" | "conflicting_signals";
  simulated: boolean;
  freshness: PresenceFreshness;
  /** Occupancy does not identify, count, or locate named people. */
  identifiesPeople: false;
}

export interface PersonPresenceSignal {
  signalId: string;
  personId: string;
  roomId: string;
  method: "device-presence" | "personal-presence-sensor" | "camera-appearance";
  state: "present" | "absent" | "unknown";
  observedAt: string;
  simulated: boolean;
}

export interface RoomLocationConsent {
  personId: string;
  purpose: "room-location";
  /** Consent is bound to each device/sensor, never inferred from camera permission. */
  allowedSignalIds: string[];
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export type PersonRoomResult = {
  personId: string;
  simulated: boolean;
  freshness: PresenceFreshness;
} & (
  | { status: "available"; roomId: string; method: "consented-presence-signal" }
  | { status: "unavailable"; reason: "no_active_consent" | "camera_identification_not_supported" | "no_current_location" | "stale_signals" | "conflicting_signals" | "clock_skew" }
);

function time(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error("Signal and consent timestamps must include a timezone");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid signal or consent timestamp");
  return parsed;
}

function context(options: PresenceOptions): { nowMs: number; maxAgeMs: number } {
  const nowMs = (options.now ?? new Date()).getTime();
  const maxAgeMs = options.maxAgeMs ?? 120_000;
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("maxAgeMs must be nonnegative");
  return { nowMs, maxAgeMs };
}

function freshness(observedAt: string | null, nowMs: number, maxAgeMs: number): PresenceFreshness {
  const ageMs = observedAt === null ? null : nowMs - time(observedAt);
  return {
    evaluatedAt: new Date(nowMs).toISOString(), observedAt, ageMs, maxAgeMs,
    state: ageMs === null ? "unknown" : ageMs < 0 ? "clock-skew" : ageMs > maxAgeMs ? "stale" : "fresh",
  };
}

function latestPerSignal<T extends { signalId: string; observedAt: string; roomId: string; state: string; method: string; simulated: boolean }>(signals: T[]): { readings: T[]; conflicts: T[] } {
  const latest = new Map<string, T[]>();
  for (const signal of signals) {
    const observed = time(signal.observedAt);
    const previous = latest.get(signal.signalId)?.[0];
    if (!previous || observed > time(previous.observedAt)) latest.set(signal.signalId, [signal]);
    else if (observed === time(previous.observedAt)
      && (signal.roomId !== previous.roomId || signal.state !== previous.state
        || signal.method !== previous.method || signal.simulated !== previous.simulated)) {
      latest.get(signal.signalId)!.push(signal);
    }
  }
  return {
    readings: [...latest.values()].map((group) => group[0]!).sort((a, b) => time(b.observedAt) - time(a.observedAt)),
    conflicts: [...latest.values()].filter((group) => group.length > 1).flat(),
  };
}

export function syntheticOccupancySignals(referenceTime = "2026-01-01T12:00:00.000Z"): OccupancySignal[] {
  const at = time(referenceTime);
  return [
    { signalId: "mock-occupancy-living", roomId: "mock-room-living", method: "occupancy-sensor", state: "detected", observedAt: new Date(at - 10_000).toISOString(), simulated: true },
    { signalId: "mock-occupancy-entry", roomId: "mock-room-entry", method: "occupancy-sensor", state: "not-detected", observedAt: new Date(at - 20_000).toISOString(), simulated: true },
  ];
}

export function getRoomOccupancy(roomId: string, signals: OccupancySignal[], options: PresenceOptions = {}): RoomOccupancyResult {
  const { nowMs, maxAgeMs } = context(options);
  if (!roomId.trim()) throw new Error("roomId must be nonempty");
  const latest = latestPerSignal(signals);
  const readings = latest.readings.filter((signal) => signal.roomId === roomId);
  const conflicts = latest.conflicts.filter((signal) => signal.roomId === roomId);
  const base = {
    roomId, simulated: readings.length > 0 && readings.every((signal) => signal.simulated),
    freshness: freshness(readings[0]?.observedAt ?? null, nowMs, maxAgeMs), identifiesPeople: false as const,
  };
  if (conflicts.some((signal) => nowMs - time(signal.observedAt) >= 0 && nowMs - time(signal.observedAt) <= maxAgeMs)) {
    return { ...base, status: "unknown", reason: "conflicting_signals" };
  }
  if (!readings.length) return { ...base, status: "unknown", reason: "no_signals" };
  if (readings.some((signal) => time(signal.observedAt) > nowMs)) return { ...base, status: "unknown", reason: "clock_skew" };
  const current = readings.filter((signal) => nowMs - time(signal.observedAt) <= maxAgeMs);
  if (!current.length) return { ...base, status: "unknown", reason: "stale_signals" };
  const detected = current.find((signal) => signal.state === "detected");
  if (detected) return { ...base, freshness: freshness(detected.observedAt, nowMs, maxAgeMs), status: "occupied", reason: "sensor_detected" };
  // Only an occupancy sensor can support an explicit unoccupied reading.
  const clear = current.find((signal) => signal.method === "occupancy-sensor" && signal.state === "not-detected");
  if (clear) {
    return { ...base, freshness: freshness(clear.observedAt, nowMs, maxAgeMs), status: "unoccupied", reason: "occupancy_sensor_clear" };
  }
  return { ...base, status: "unknown", reason: current.some((signal) => signal.method === "motion-sensor" && signal.state === "not-detected") ? "motion_inactive_is_not_empty" : "unknown_signals" };
}

/**
 * Never infers identity from images or connects an anonymous camera event to a
 * person. Device/sensor presence is only an indication, not visual confirmation.
 */
export function locateConsentedPerson(
  personId: string,
  signals: PersonPresenceSignal[] = [],
  consents: RoomLocationConsent[] = [],
  options: PresenceOptions = {},
): PersonRoomResult {
  const { nowMs, maxAgeMs } = context(options);
  if (!personId.trim()) throw new Error("personId must be nonempty");
  const relevant = signals.filter((signal) => signal.personId === personId);
  const base = {
    personId, simulated: relevant.length > 0 && relevant.every((signal) => signal.simulated),
    freshness: freshness(null, nowMs, maxAgeMs),
  };
  // Refuse this source even if someone incorrectly supplies a consent record.
  if (relevant.some((signal) => signal.method === "camera-appearance")) {
    return { ...base, status: "unavailable", reason: "camera_identification_not_supported" };
  }
  const activeConsent = consents.filter((consent) => consent.personId === personId
    && consent.purpose === "room-location" && time(consent.grantedAt) <= nowMs
    && time(consent.expiresAt) > nowMs && (consent.revokedAt === undefined || time(consent.revokedAt) > nowMs));
  if (!activeConsent.length) return { ...base, status: "unavailable", reason: "no_active_consent" };
  const latest = latestPerSignal(relevant.filter((signal) => activeConsent.some((consent) =>
    consent.allowedSignalIds.includes(signal.signalId) && time(signal.observedAt) >= time(consent.grantedAt))));
  const permitted = latest.readings;
  const attributed = { ...base, freshness: freshness(permitted[0]?.observedAt ?? null, nowMs, maxAgeMs) };
  if (permitted.some((signal) => time(signal.observedAt) > nowMs)) return { ...attributed, status: "unavailable", reason: "clock_skew" };
  const current = permitted.filter((signal) => nowMs - time(signal.observedAt) <= maxAgeMs);
  if (permitted.length > 0 && current.length === 0) return { ...attributed, status: "unavailable", reason: "stale_signals" };
  if (latest.conflicts.some((signal) => nowMs - time(signal.observedAt) <= maxAgeMs)) {
    return { ...attributed, status: "unavailable", reason: "conflicting_signals" };
  }
  const present = current.filter((signal) => signal.state === "present");
  const rooms = new Set(present.map((signal) => signal.roomId));
  if (rooms.size > 1) return { ...attributed, status: "unavailable", reason: "conflicting_signals" };
  const roomId = [...rooms][0];
  return roomId === undefined ? { ...attributed, status: "unavailable", reason: "no_current_location" }
    : { ...attributed, freshness: freshness(present[0]!.observedAt, nowMs, maxAgeMs), status: "available", roomId, method: "consented-presence-signal" };
}
