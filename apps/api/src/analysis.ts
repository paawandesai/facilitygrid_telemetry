import type { FastifyInstance } from "fastify";
import { pool } from "./db.js";

/**
 * Read-only views over history: trends and outliers for the analysis pages, and
 * live counters that show the three invariants doing their job. Everything is
 * computed from `readings` (late readings included, since history is the truth);
 * nothing here writes.
 */

const clampMinutes = (raw: unknown, fallback: number) => Math.round(Math.min(Math.max(Number(raw) || fallback, 1), 7 * 24 * 60));

// Numeric readings of every (device, metric) in a time window. Driven from
// device_metric_state so each key uses the (device_id, metric, event_time) index.
const WINDOW_CTE = `
  k AS (
    SELECT device_id, metric FROM device_metric_state WHERE ($2::text IS NULL OR device_id = $2)
  ),
  x AS (
    SELECT k.device_id, k.metric, r.event_time, r.late, (r.value #>> '{}')::float8 AS v
      FROM k CROSS JOIN LATERAL (
        SELECT event_time, value, late FROM readings r
         WHERE r.device_id = k.device_id AND r.metric = k.metric
           AND r.event_time > now() - make_interval(mins => $1)
           AND jsonb_typeof(r.value) = 'number'
      ) r
  ),
  s AS (
    SELECT device_id, metric, count(*)::int AS n, min(v) AS min, max(v) AS max, avg(v) AS avg,
           coalesce(stddev_samp(v), 0) AS sd,
           regr_slope(v, extract(epoch FROM event_time)) * 3600 AS slope_per_hour
      FROM x GROUP BY 1, 2
  )`;

/** Bucket width so a window draws as roughly `points` points, never finer than 10 s. */
const bucketSeconds = (minutes: number, points: number) => Math.max(10, Math.ceil((minutes * 60) / points));

export interface MetricAnalysis {
  device_id: string;
  metric: string;
  n: number;
  min: number;
  max: number;
  avg: number;
  sd: number;
  slope_per_hour: number | null;
  outliers: number;
  last: unknown;
  /** [bucket start ms, avg, min, max] */
  series: [number, number, number, number][];
}

/** A reading more than this many standard deviations from its window's mean is an outlier. */
const OUTLIER_Z = 3;

let proofCache: { at: number; body: unknown } | null = null;
const PROOF_TTL_MS = 5000;

export function registerAnalysis(app: FastifyInstance) {
  // Fleet-wide (or one device): stats, outlier counts and a bucketed series per numeric metric.
  app.get<{ Querystring: { minutes?: string; points?: string; device_id?: string } }>("/analysis", async (req) => {
    const minutes = clampMinutes(req.query.minutes, 60);
    const points = Math.round(Math.min(Math.max(Number(req.query.points) || 60, 10), 400));
    return analyse(minutes, bucketSeconds(minutes, points), req.query.device_id ?? null);
  });

  // One device in detail: the same stats plus the individual outlier and late points to mark on a chart.
  app.get<{ Params: { id: string }; Querystring: { minutes?: string; points?: string } }>(
    "/devices/:id/analysis",
    async (req) => {
      const minutes = clampMinutes(req.query.minutes, 60);
      const points = Math.round(Math.min(Math.max(Number(req.query.points) || 120, 10), 400));
      const id = req.params.id;
      const [metrics, marks] = await Promise.all([
        analyse(minutes, bucketSeconds(minutes, points), id),
        pool.query(
          `WITH ${WINDOW_CTE}
           SELECT x.metric, x.event_time, x.v, x.late,
                  CASE WHEN s.sd > 0 THEN (x.v - s.avg) / s.sd END AS z
             FROM x JOIN s USING (device_id, metric)
            WHERE x.late OR (s.sd > 0 AND abs(x.v - s.avg) > $3 * s.sd)
            ORDER BY x.event_time DESC
            LIMIT 500`,
          [minutes, id, OUTLIER_Z],
        ),
      ]);
      return {
        minutes,
        metrics,
        points: marks.rows.map((r) => ({
          metric: r.metric,
          t: r.event_time.getTime(),
          v: r.v,
          late: r.late,
          outlier: r.z !== null && Math.abs(r.z) > OUTLIER_Z,
          z: r.z,
        })),
      };
    },
  );

  // Counters that make the invariants visible, plus the same checks as scripts/check.sql.
  app.get("/proof", async () => {
    if (proofCache && Date.now() - proofCache.at < PROOF_TTL_MS) return proofCache.body;
    const [counts, checks] = await Promise.all([
      pool.query(`
        WITH firsts AS (
               SELECT device_id, gateway_id, min(received_at) AS t FROM readings GROUP BY 1, 2
             ),
             d AS (SELECT device_id, min(t) AS t0 FROM firsts GROUP BY 1)
        SELECT (SELECT coalesce(sum(resend_count), 0)::bigint FROM readings)            AS duplicates_dropped,
               (SELECT count(*) FROM readings WHERE resend_count > 0)::int               AS readings_resent,
               (SELECT count(*) FROM readings)::bigint                                   AS readings_stored,
               (SELECT count(*) FROM readings WHERE late)::int                           AS late_ignored,
               (SELECT count(*) FROM readings WHERE late AND lane = 'backlog')::int      AS late_backlog,
               (SELECT count(*) FROM readings WHERE lane = 'backlog')::int               AS backlog_total,
               (SELECT count(*) FROM firsts f JOIN d USING (device_id) JOIN devices v USING (device_id)
                 WHERE f.gateway_id <> v.first_seen_gateway_id
                   AND f.t - d.t0 < interval '5 seconds')::int                           AS race_registrations_deduped,
               (SELECT count(*) FROM devices)::int                                       AS devices,
               (SELECT count(*) FROM anomalies WHERE kind = 'conflicting_resend')::int   AS conflicting_resends`),
      pool.query(`
        SELECT (SELECT count(*) - count(DISTINCT (gateway_id, device_id, metric, sequence)) FROM readings)::int
                 AS duplicate_rows,
               (SELECT count(*) FROM device_metric_state s
                  JOIN LATERAL (
                    SELECT gateway_id, sequence FROM readings r
                     WHERE r.device_id = s.device_id AND r.metric = s.metric
                     ORDER BY event_time DESC, gateway_id DESC, sequence DESC LIMIT 1
                  ) newest ON true
                 WHERE (newest.gateway_id, newest.sequence) <> (s.gateway_id, s.sequence))::int
                 AS state_not_newest,
               (SELECT abs((SELECT count(DISTINCT device_id) FROM readings) - (SELECT count(*) FROM devices)))::int
                 AS registration_mismatch`),
    ]);
    const c = counts.rows[0];
    const body = {
      checked_at: new Date().toISOString(),
      ...c,
      duplicates_dropped: Number(c.duplicates_dropped),
      readings_stored: Number(c.readings_stored),
      checks: checks.rows[0],
    };
    proofCache = { at: Date.now(), body };
    return body;
  });
}

async function analyse(minutes: number, bucket: number, deviceId: string | null): Promise<MetricAnalysis[]> {
  const { rows } = await pool.query(
    `WITH ${WINDOW_CTE},
     o AS (
       SELECT x.device_id, x.metric, count(*)::int AS outliers
         FROM x JOIN s USING (device_id, metric)
        WHERE s.sd > 0 AND abs(x.v - s.avg) > $4 * s.sd
        GROUP BY 1, 2
     ),
     b AS (
       SELECT device_id, metric,
              json_agg(json_build_array((extract(epoch FROM t) * 1000)::bigint, a, lo, hi) ORDER BY t) AS series
         FROM (SELECT device_id, metric,
                      date_bin(make_interval(secs => $3), event_time, timestamptz '1970-01-01 00:00:00+00') AS t,
                      avg(v) AS a, min(v) AS lo, max(v) AS hi
                 FROM x GROUP BY 1, 2, 3) q
        GROUP BY 1, 2
     )
     SELECT s.*, coalesce(o.outliers, 0) AS outliers, b.series, st.value AS last
       FROM s
       JOIN device_metric_state st USING (device_id, metric)
       LEFT JOIN o USING (device_id, metric)
       LEFT JOIN b USING (device_id, metric)
      ORDER BY s.device_id, s.metric`,
    [minutes, deviceId, bucket, OUTLIER_Z],
  );
  return rows.map((r) => ({ ...r, series: r.series ?? [] }));
}
