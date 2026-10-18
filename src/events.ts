/** Camera history contracts. This module never reads a camera or fetches media. */
export type CameraEventType = "motion" | "anonymous-person" | "animal" | "vehicle" | "doorbell" | "sound";

export interface CameraMediaReference {
  /** Opaque fixture/provider identifier; deliberately not a URL or local path. */
  assetId: string;
  kind: "image" | "clip";
  availability: "metadata-only";
}

export interface CameraEvent {
  id: string;
  cameraId: string;
  roomId: string;
  type: CameraEventType;
  observedAt: string;
  media: CameraMediaReference[];
}

export interface CameraEventQuery {
  cameraId?: string | undefined;
  roomId?: string | undefined;
  types?: CameraEventType[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export interface ValidatedCameraEventQuery extends CameraEventQuery {
  from: string;
  to: string;
  limit: number;
}

export type CameraProviderResult =
  | { status: "available"; events: CameraEvent[] }
  | { status: "unavailable"; reason: "public_history_api_unavailable" | "not_configured"; detail: string };

/** An approved future adapter must preserve availability and source attribution. */
export interface CameraEventProvider {
  readonly id: string;
  readonly mode: "mock" | "unavailable";
  searchEvents(query: ValidatedCameraEventQuery): Promise<CameraProviderResult>;
}

export interface EventFreshness {
  evaluatedAt: string;
  latestEventAt: string | null;
  ageMs: number | null;
  maxAgeMs: number;
  state: "fresh" | "stale" | "unknown";
}

interface SearchAttribution {
  providerId: string;
  simulated: boolean;
  query: ValidatedCameraEventQuery;
  freshness: EventFreshness;
}

export type CameraEventSearchResult = SearchAttribution & (
  | { status: "available"; events: CameraEvent[]; mediaAccess: "metadata-only" }
  | { status: "unavailable"; reason: "public_history_api_unavailable" | "not_configured"; detail: string }
);

const EVENT_TYPES = new Set<CameraEventType>(["motion", "anonymous-person", "animal", "vehicle", "doorbell", "sound"]);
const DAY_MS = 86_400_000;

function timestamp(value: string, label: string): number {
  // Require a timezone so the same query cannot mean different times on two Macs.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error(`${label} must be an ISO 8601 timestamp with a timezone`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

function validateQuery(query: CameraEventQuery, nowMs: number): ValidatedCameraEventQuery {
  const fromMs = query.from === undefined ? nowMs - DAY_MS : timestamp(query.from, "from");
  const toMs = query.to === undefined ? nowMs : timestamp(query.to, "to");
  if (fromMs > toMs) throw new Error("from must be before or equal to to");
  if (toMs > nowMs) throw new Error("to must not be in the future");
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer from 1 to 200");
  for (const key of ["cameraId", "roomId"] as const) {
    if (query[key] !== undefined && (typeof query[key] !== "string" || !query[key]?.trim())) {
      throw new Error(`${key} must be a nonempty identifier`);
    }
  }
  if (query.types !== undefined && (!Array.isArray(query.types) || query.types.some((type) => !EVENT_TYPES.has(type)))) {
    throw new Error("types contains an unsupported event type; person identification is not supported");
  }
  return { ...query, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), limit };
}

function cloneEvent(event: CameraEvent): CameraEvent {
  return { ...event, media: event.media.map((reference) => ({ ...reference })) };
}

export function syntheticCameraEvents(referenceTime = "2026-01-01T12:00:00.000Z"): CameraEvent[] {
  const at = timestamp(referenceTime, "referenceTime");
  return [
    {
      id: "mock-event-1", cameraId: "mock-camera-entry", roomId: "mock-room-entry",
      type: "motion", observedAt: new Date(at - 60_000).toISOString(),
      media: [{ assetId: "mock-image-1", kind: "image", availability: "metadata-only" }],
    },
    {
      id: "mock-event-2", cameraId: "mock-camera-living", roomId: "mock-room-living",
      type: "anonymous-person", observedAt: new Date(at - 120_000).toISOString(),
      media: [{ assetId: "mock-clip-2", kind: "clip", availability: "metadata-only" }],
    },
  ];
}

/** Explicit opt-in synthetic data. An empty result here means a successful query. */
export class LocalMockCameraProvider implements CameraEventProvider {
  readonly id = "synthetic-camera-history";
  readonly mode = "mock" as const;
  private readonly events: CameraEvent[];

  constructor(events: CameraEvent[] = syntheticCameraEvents()) {
    this.events = events.map((event) => {
      timestamp(event.observedAt, "observedAt");
      if (!EVENT_TYPES.has(event.type)) throw new Error("Unsupported mock event type");
      for (const media of event.media) {
        if (!/^[A-Za-z0-9_-]+$/.test(media.assetId) || media.availability !== "metadata-only") {
          throw new Error("Media references must be opaque metadata-only identifiers");
        }
      }
      return cloneEvent(event);
    });
  }

  async searchEvents(query: ValidatedCameraEventQuery): Promise<CameraProviderResult> {
    const from = timestamp(query.from, "from");
    const to = timestamp(query.to, "to");
    return {
      status: "available",
      events: this.events.filter((event) => {
        const observed = timestamp(event.observedAt, "observedAt");
        return observed >= from && observed <= to
          && (query.cameraId === undefined || query.cameraId === event.cameraId)
          && (query.roomId === undefined || query.roomId === event.roomId)
          && (query.types === undefined || query.types.includes(event.type));
      }).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
        .slice(0, query.limit).map(cloneEvent),
    };
  }
}

/** No public HomeKit API is assumed to expose HomeKit Secure Video/iCloud history. */
export class HomeKitSecureVideoHistoryProvider implements CameraEventProvider {
  readonly id = "homekit-secure-video-history";
  readonly mode = "unavailable" as const;

  async searchEvents(_query: ValidatedCameraEventQuery): Promise<CameraProviderResult> {
    return {
      status: "unavailable",
      reason: "public_history_api_unavailable",
      detail: "HomeKit Secure Video/iCloud recording history is unavailable through the supported public HomeKit API. Camera authorization or a current snapshot does not provide recording history.",
    };
  }
}

export async function searchCameraEvents(
  provider: CameraEventProvider,
  query: CameraEventQuery = {},
  options: { now?: Date; maxAgeMs?: number } = {},
): Promise<CameraEventSearchResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");
  const maxAgeMs = options.maxAgeMs ?? 300_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("maxAgeMs must be nonnegative");
  const validated = validateQuery(query, nowMs);
  const result = await provider.searchEvents(validated);
  const newest = result.status === "available" && result.events.length > 0
    ? Math.max(...result.events.map((event) => timestamp(event.observedAt, "observedAt"))) : null;
  const ageMs = newest === null ? null : nowMs - newest;
  const attribution: SearchAttribution = {
    providerId: provider.id, simulated: provider.mode === "mock", query: validated,
    freshness: {
      evaluatedAt: now.toISOString(), latestEventAt: newest === null ? null : new Date(newest).toISOString(),
      ageMs, maxAgeMs, state: ageMs === null ? "unknown" : ageMs <= maxAgeMs ? "fresh" : "stale",
    },
  };
  return result.status === "unavailable" ? { ...attribution, ...result }
    : { ...attribution, status: "available", events: result.events, mediaAccess: "metadata-only" };
}
