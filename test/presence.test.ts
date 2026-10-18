import assert from "node:assert/strict";
import test from "node:test";
import {
  getRoomOccupancy,
  locateConsentedPerson,
  syntheticOccupancySignals,
  type OccupancySignal,
  type PersonPresenceSignal,
  type RoomLocationConsent,
} from "../src/presence.js";

const now = new Date("2026-01-01T12:00:00.000Z");
const recent = "2026-01-01T11:59:30.000Z";
const stale = "2026-01-01T11:00:00.000Z";

function occupancy(overrides: Partial<OccupancySignal> = {}): OccupancySignal {
  return { signalId: "mock-sensor", roomId: "room-1", method: "occupancy-sensor", state: "detected", observedAt: recent, simulated: true, ...overrides };
}

function presence(overrides: Partial<PersonPresenceSignal> = {}): PersonPresenceSignal {
  return { signalId: "mock-person-device", personId: "person-1", roomId: "room-1", method: "device-presence", state: "present", observedAt: recent, simulated: true, ...overrides };
}

function consent(overrides: Partial<RoomLocationConsent> = {}): RoomLocationConsent {
  return { personId: "person-1", purpose: "room-location", allowedSignalIds: ["mock-person-device"], grantedAt: "2026-01-01T10:00:00Z", expiresAt: "2026-01-01T13:00:00Z", ...overrides };
}

test("synthetic occupancy is labelled and never identifies a person", () => {
  const result = getRoomOccupancy("mock-room-living", syntheticOccupancySignals(), { now });
  assert.equal(result.status, "occupied");
  assert.equal(result.simulated, true);
  assert.equal(result.identifiesPeople, false);
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.freshness.ageMs, 10_000);
});

test("missing, stale, and future readings yield unknown occupancy", () => {
  assert.equal(getRoomOccupancy("room-1", [], { now }).reason, "no_signals");
  const old = getRoomOccupancy("room-1", [occupancy({ observedAt: stale })], { now });
  assert.equal(old.status, "unknown");
  assert.equal(old.reason, "stale_signals");
  assert.equal(old.freshness.state, "stale");
  const future = getRoomOccupancy("room-1", [occupancy({ observedAt: "2026-01-01T12:01:00Z" })], { now });
  assert.equal(future.reason, "clock_skew");
  assert.equal(future.freshness.state, "clock-skew");
});

test("motion inactivity cannot prove an empty room; explicit occupancy clear can", () => {
  const inactive = getRoomOccupancy("room-1", [occupancy({ method: "motion-sensor", state: "not-detected" })], { now });
  assert.equal(inactive.status, "unknown");
  assert.equal(inactive.reason, "motion_inactive_is_not_empty");
  const clear = getRoomOccupancy("room-1", [occupancy({ state: "not-detected" })], { now });
  assert.equal(clear.status, "unoccupied");
  assert.equal(clear.reason, "occupancy_sensor_clear");
});

test("newest reading per sensor wins and fresh positive readings are conservative", () => {
  const readings = [occupancy({ observedAt: stale }), occupancy({ state: "not-detected" })];
  assert.equal(getRoomOccupancy("room-1", readings, { now }).status, "unoccupied");
  assert.equal(getRoomOccupancy("room-1", [...readings, occupancy({ signalId: "motion", method: "motion-sensor" })], { now }).status, "occupied");
});

test("occupancy freshness describes its evidence, not a newer unknown reading", () => {
  const result = getRoomOccupancy("room-1", [occupancy(), occupancy({ signalId: "unknown", state: "unknown", observedAt: "2026-01-01T11:59:59Z" })], { now });
  assert.equal(result.status, "occupied");
  assert.equal(result.freshness.observedAt, recent);
  assert.equal(result.freshness.ageMs, 30_000);
});

test("contradictory equal-time occupancy readings remain unknown regardless of order", () => {
  const readings = [occupancy(), occupancy({ state: "not-detected" })];
  for (const order of [readings, [...readings].reverse()]) {
    const result = getRoomOccupancy("room-1", order, { now });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "conflicting_signals");
  }
});

test("latest readings follow a signal across rooms instead of reviving old occupancy", () => {
  const result = getRoomOccupancy("room-1", [occupancy({ observedAt: stale }), occupancy({ roomId: "room-2" })], { now });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "no_signals");
});

test("named-person location is unavailable by default and without signal-specific consent", () => {
  assert.equal(locateConsentedPerson("person-1", [], [], { now }).status, "unavailable");
  const noConsent = locateConsentedPerson("person-1", [presence()], [], { now });
  assert.equal(noConsent.status, "unavailable");
  if (noConsent.status !== "unavailable") assert.fail("must require consent");
  assert.equal(noConsent.reason, "no_active_consent");
  assert.equal("roomId" in noConsent, false);
  const wrongDevice = locateConsentedPerson("person-1", [presence()], [consent({ allowedSignalIds: ["different-device"] })], { now });
  assert.equal(wrongDevice.status, "unavailable");
  if (wrongDevice.status !== "unavailable") assert.fail("must require device consent");
  assert.equal(wrongDevice.reason, "no_current_location");
});

test("explicit active consent enables only a current device/sensor presence indication", () => {
  const result = locateConsentedPerson("person-1", [presence()], [consent()], { now });
  assert.equal(result.status, "available");
  if (result.status !== "available") assert.fail("valid synthetic consent should allow synthetic signal");
  assert.equal(result.roomId, "room-1");
  assert.equal(result.method, "consented-presence-signal");
  assert.equal(result.simulated, true);
  assert.equal(result.freshness.observedAt, recent);
});

test("presence collected before consent is not reused for location", () => {
  const result = locateConsentedPerson("person-1", [presence()], [consent({ grantedAt: "2026-01-01T11:59:45Z" })], { now });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") assert.fail("pre-consent location must be unavailable");
  assert.equal(result.reason, "no_current_location");
  assert.equal(result.freshness.observedAt, null);
});

test("person location freshness describes present evidence rather than a newer absent device", () => {
  const result = locateConsentedPerson("person-1", [presence(), presence({ signalId: "second-device", state: "absent", observedAt: "2026-01-01T11:59:59Z" })], [consent({ allowedSignalIds: ["mock-person-device", "second-device"] })], { now });
  assert.equal(result.status, "available");
  assert.equal(result.freshness.observedAt, recent);
  assert.equal(result.freshness.ageMs, 30_000);
});

test("revoked, expired, and future consent do not grant access", () => {
  for (const invalid of [
    consent({ revokedAt: "2026-01-01T11:00:00Z" }),
    consent({ expiresAt: "2026-01-01T12:00:00Z" }),
    consent({ grantedAt: "2026-01-01T12:01:00Z" }),
    consent({ personId: "other-person" }),
  ]) {
    const result = locateConsentedPerson("person-1", [presence()], [invalid], { now });
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") assert.fail("invalid consent should not allow location");
    assert.equal(result.reason, "no_active_consent");
    assert.equal("roomId" in result, false);
  }
});

test("camera-based person identification is rejected even when consent is supplied", () => {
  const result = locateConsentedPerson("person-1", [presence({ method: "camera-appearance" })], [consent()], { now });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") assert.fail("camera identification must be rejected");
  assert.equal(result.reason, "camera_identification_not_supported");
  assert.equal("roomId" in result, false);
});

test("stale or conflicting person presence is unavailable, never guessed", () => {
  const old = locateConsentedPerson("person-1", [presence({ observedAt: stale })], [consent()], { now });
  assert.equal(old.status, "unavailable");
  if (old.status !== "unavailable") assert.fail("stale location must be unavailable");
  assert.equal(old.reason, "stale_signals");
  assert.equal(old.freshness.state, "stale");
  const conflict = locateConsentedPerson("person-1", [presence(), presence({ signalId: "second", roomId: "room-2" })], [consent({ allowedSignalIds: ["mock-person-device", "second"] })], { now });
  assert.equal(conflict.status, "unavailable");
  if (conflict.status !== "unavailable") assert.fail("conflicting location must be unavailable");
  assert.equal(conflict.reason, "conflicting_signals");
});

test("a single device with contradictory equal-time room readings is unavailable", () => {
  const readings = [presence(), presence({ roomId: "room-2" })];
  for (const order of [readings, [...readings].reverse()]) {
    const result = locateConsentedPerson("person-1", order, [consent()], { now });
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") assert.fail("contradictory device location must be unavailable");
    assert.equal(result.reason, "conflicting_signals");
  }
});

test("latest absent reading removes an earlier location and clock skew is unavailable", () => {
  const absent = locateConsentedPerson("person-1", [presence({ observedAt: stale }), presence({ state: "absent" })], [consent()], { now });
  assert.equal(absent.status, "unavailable");
  if (absent.status !== "unavailable") assert.fail("absent device has no current room");
  assert.equal(absent.reason, "no_current_location");
  const future = locateConsentedPerson("person-1", [presence({ observedAt: "2026-01-01T12:01:00Z" })], [consent()], { now });
  assert.equal(future.status, "unavailable");
  if (future.status !== "unavailable") assert.fail("future location must be unavailable");
  assert.equal(future.reason, "clock_skew");
});
