import assert from "node:assert/strict";
import test from "node:test";
import {
  HomeKitSecureVideoHistoryProvider,
  LocalMockCameraProvider,
  searchCameraEvents,
  syntheticCameraEvents,
} from "../src/events.js";

const now = new Date("2026-01-01T12:00:00.000Z");

test("synthetic event search filters rooms/types and returns timestamped metadata only", async () => {
  const result = await searchCameraEvents(new LocalMockCameraProvider(), {
    roomId: "mock-room-living", types: ["anonymous-person"],
  }, { now });
  assert.equal(result.status, "available");
  if (result.status !== "available") assert.fail("mock query should succeed");
  assert.equal(result.simulated, true);
  assert.equal(result.providerId, "synthetic-camera-history");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.id, "mock-event-2");
  assert.equal(result.events[0]?.observedAt, "2026-01-01T11:58:00.000Z");
  assert.equal(result.mediaAccess, "metadata-only");
  assert.deepEqual(result.events[0]?.media, [{ assetId: "mock-clip-2", kind: "clip", availability: "metadata-only" }]);
  assert.equal(result.freshness.ageMs, 120_000);
  assert.equal(result.freshness.state, "fresh");
});

test("history unsupported is unavailable, never an empty search result", async () => {
  const result = await searchCameraEvents(new HomeKitSecureVideoHistoryProvider(), {}, { now });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") assert.fail("history must be unavailable");
  assert.equal(result.reason, "public_history_api_unavailable");
  assert.equal(result.simulated, false);
  assert.equal("events" in result, false);
  assert.equal(result.freshness.state, "unknown");
  assert.equal(result.freshness.latestEventAt, null);
});

test("available search with no matching events remains available with unknown freshness", async () => {
  const result = await searchCameraEvents(new LocalMockCameraProvider(), { cameraId: "missing" }, { now });
  assert.equal(result.status, "available");
  if (result.status !== "available") assert.fail("mock query should succeed");
  assert.deepEqual(result.events, []);
  assert.equal(result.freshness.state, "unknown");
});

test("events are newest first, limited, and filtered by inclusive time bounds", async () => {
  const result = await searchCameraEvents(new LocalMockCameraProvider(), {
    from: "2026-01-01T11:58:00Z", to: "2026-01-01T11:59:00Z", limit: 1,
  }, { now, maxAgeMs: 30_000 });
  assert.equal(result.status, "available");
  if (result.status !== "available") assert.fail("mock query should succeed");
  assert.deepEqual(result.events.map((event) => event.id), ["mock-event-1"]);
  assert.equal(result.freshness.state, "stale");
});

test("invalid ranges, future requests, limits, and unsupported identification are rejected", async () => {
  const provider = new LocalMockCameraProvider();
  await assert.rejects(searchCameraEvents(provider, { from: "2026-01-01T12:00:00" }, { now }), /timezone/);
  await assert.rejects(searchCameraEvents(provider, { from: "2026-01-01T12:00:00Z", to: "2026-01-01T11:00:00Z" }, { now }), /before/);
  await assert.rejects(searchCameraEvents(provider, { to: "2026-01-01T12:00:01Z" }, { now }), /future/);
  await assert.rejects(searchCameraEvents(provider, { limit: 201 }, { now }), /limit/);
  await assert.rejects(searchCameraEvents(provider, { types: ["named-person" as never] }, { now }), /identification is not supported/);
});

test("fixtures and results are isolated and reject URL/path media references", async () => {
  const fixtures = syntheticCameraEvents();
  const provider = new LocalMockCameraProvider(fixtures);
  fixtures[0]!.media[0]!.assetId = "changed";
  const first = await searchCameraEvents(provider, {}, { now });
  if (first.status !== "available") assert.fail("mock query should succeed");
  first.events[0]!.media[0]!.assetId = "changed-again";
  const second = await searchCameraEvents(provider, {}, { now });
  if (second.status !== "available") assert.fail("mock query should succeed");
  assert.equal(second.events[0]?.media[0]?.assetId, "mock-image-1");
  const unsafe = syntheticCameraEvents();
  unsafe[0]!.media[0]!.assetId = "https://camera.invalid/live.jpg";
  assert.throws(() => new LocalMockCameraProvider(unsafe), /opaque/);
});
