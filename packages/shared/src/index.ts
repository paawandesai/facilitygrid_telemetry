import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire contract: POST /ingest/readings
// {gateway_id, device_id, metric, value, event_time, sequence}
// ---------------------------------------------------------------------------

export const TOPICS = {
  live: "readings.live",
  backlog: "readings.backlog",
  dlq: "readings.dlq",
} as const;

/** A reading whose event_time is older than this (vs. arrival) goes to the backlog lane. */
export const BACKLOG_THRESHOLD_MS = 60_000;
/** Readings stamped further than this into the future are rejected (bad gateway clock). */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** A gateway silent for longer than this marks its devices' values as stale. */
export const DEFAULT_STALE_AFTER_MS = 30_000;

const id = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .pipe(z.string().min(1, "must not be empty").max(200));

/**
 * event_time accepts an ISO-8601 string or epoch seconds/milliseconds.
 * The normalised form is an ISO string with an explicit offset, keeping any
 * sub-millisecond digits so Postgres (microsecond precision) sees the original
 * instant.
 */
export function normaliseEventTime(raw: unknown): { iso: string; ms: number } | null {
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim()))) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    // Heuristic: anything above 1e11 is milliseconds (1e11 s is the year 5138).
    const ms = n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return { iso: d.toISOString(), ms: d.getTime() };
  }
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/.test(s)) return null;
  // No zone designator: treat as UTC rather than the server's local zone.
  if (!/(Z|z|[+-]\d{2}(:?\d{2})?)$/.test(s)) s += "Z";
  s = s.replace(" ", "T");
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return { iso: s, ms };
}

export const ReadingInput = z
  .object({
    gateway_id: id,
    device_id: id,
    metric: id,
    // Numbers, status strings ("running"), booleans: stored as jsonb as sent.
    value: z.custom<unknown>((v) => v !== undefined, { message: "value is required" }),
    event_time: z.union([z.string(), z.number()]),
    sequence: z
      .union([z.number(), z.string().regex(/^\d+$/)])
      .transform((v) => Number(v))
      .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  })
  .transform((r, ctx) => {
    const t = normaliseEventTime(r.event_time);
    if (!t) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["event_time"], message: "unparseable event_time" });
      return z.NEVER;
    }
    return { ...r, event_time: t.iso, event_time_ms: t.ms };
  });

export type Reading = z.output<typeof ReadingInput>;

/** What the API puts on the broker. */
export interface ReadingMessage {
  gateway_id: string;
  device_id: string;
  metric: string;
  value: unknown;
  event_time: string;
  sequence: number;
  received_at: string;
  lane: Lane;
}

export type Lane = "live" | "backlog";

export function chooseLane(eventTimeMs: number, nowMs: number): Lane {
  return nowMs - eventTimeMs > BACKLOG_THRESHOLD_MS ? "backlog" : "live";
}

/**
 * The total order used for "current state": event_time first, then
 * (gateway_id, sequence) as a deterministic tie-break. Postgres compares the
 * same tuple with COLLATE "C", which matches JS code-unit string ordering.
 */
export function compareReadings(
  a: { event_time_ms: number; gateway_id: string; sequence: number },
  b: { event_time_ms: number; gateway_id: string; sequence: number },
): number {
  if (a.event_time_ms !== b.event_time_ms) return a.event_time_ms < b.event_time_ms ? -1 : 1;
  if (a.gateway_id !== b.gateway_id) return a.gateway_id < b.gateway_id ? -1 : 1;
  return a.sequence - b.sequence;
}

// ---------------------------------------------------------------------------
// Read-side shapes shared by the API and the web app
// ---------------------------------------------------------------------------

export const ClaimInput = z.object({
  name: z.string().trim().min(1).max(200),
  equipment_type: z.string().trim().max(100).optional(),
  location: z.string().trim().max(200).optional(),
  claimed_by: z.string().trim().max(100).optional(),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

export interface MetricState {
  metric: string;
  value: unknown;
  event_time: string;
  gateway_id: string;
  sequence: number;
  updated_at: string;
  /** True when the gateway that supplied this value has gone silent. */
  stale: boolean;
}

export interface DeviceSummary {
  device_id: string;
  status: "unclaimed" | "claimed";
  name: string | null;
  equipment_type: string | null;
  location: string | null;
  first_seen_at: string;
  first_seen_gateway_id: string;
  claimed_at: string | null;
  claimed_by: string | null;
  gateways: string[];
  reading_count: number;
  metrics: MetricState[];
}

export interface ReadingRow {
  id: number;
  gateway_id: string;
  metric: string;
  value: unknown;
  event_time: string;
  sequence: number;
  ingested_at: string;
  lane: Lane;
  resend_count: number;
  late: boolean;
}

export interface GatewaySummary {
  gateway_id: string;
  last_seen_at: string;
  max_event_time: string;
  max_sequence: number;
  readings_total: number;
  duplicates_total: number;
  late_total: number;
  online: boolean;
  silent_for_ms: number;
}

export type ServerEvent =
  | { type: "device_discovered"; device_id: string; gateway_id: string }
  | { type: "state_changed"; device_ids: string[] }
  | { type: "device_claimed"; device_id: string }
  | { type: "refresh" };
