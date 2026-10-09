import type pg from "pg";
import type { ReadingMessage } from "@fg/shared";

export interface BatchResult {
  inserted: number;
  duplicates: number;
  late: number;
  conflicts: number;
  discovered: string[];
  changed: string[];
}

const RETRYABLE = new Set(["40001", "40P01"]); // serialization failure, deadlock

/** SQLSTATE classes that mean "this message can never be written", not "the database is unavailable". */
export function isPoisonError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
}

const byKey = (a: ReadingMessage, b: ReadingMessage) =>
  a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;

/**
 * Writes one broker batch in one Postgres transaction. Every statement is an
 * idempotent merge, so processing the same batch twice (crash before the
 * offset commit) or two batches concurrently (live and backlog lanes, several
 * replicas) converges to the same database state.
 */
export async function processBatch(pool: pg.Pool, messages: ReadingMessage[]): Promise<BatchResult> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await writeBatch(client, messages);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 50));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

interface GatewayAgg {
  lastSeen: string;
  lastSeenMs: number;
  maxEvent: string;
  maxEventMs: number;
  maxSeq: number;
  inserted: number;
  duplicates: number;
  late: number;
}

async function writeBatch(client: pg.PoolClient, messages: ReadingMessage[]): Promise<BatchResult> {
  // Stable sort by (device, metric): rows are locked in the same order in every
  // transaction (no deadlocks between lanes), and a key's readings keep their
  // broker order, so the `late` flag is deterministic.
  const sorted = [...messages].sort(byKey);
  const res: BatchResult = { inserted: 0, duplicates: 0, late: 0, conflicts: 0, discovered: [], changed: [] };
  const knownDevices = new Set<string>();
  const changed = new Set<string>();
  const gateways = new Map<string, GatewayAgg>();

  for (const m of sorted) {
    const value = JSON.stringify(m.value ?? null);
    const g =
      gateways.get(m.gateway_id) ??
      gateways
        .set(m.gateway_id, {
          lastSeen: m.received_at,
          lastSeenMs: 0,
          maxEvent: m.event_time,
          maxEventMs: -Infinity,
          maxSeq: 0,
          inserted: 0,
          duplicates: 0,
          late: 0,
        })
        .get(m.gateway_id)!;
    const recvMs = Date.parse(m.received_at);
    if (recvMs > g.lastSeenMs) (g.lastSeenMs = recvMs), (g.lastSeen = m.received_at);
    const evMs = Date.parse(m.event_time);
    if (evMs > g.maxEventMs) (g.maxEventMs = evMs), (g.maxEvent = m.event_time);
    g.maxSeq = Math.max(g.maxSeq, m.sequence);

    // Invariant 3: register a new device exactly once. Under a race the loser
    // blocks on the primary key until the winner commits, then does nothing.
    if (!knownDevices.has(m.device_id)) {
      const dev = await client.query(
        `INSERT INTO devices (device_id, first_seen_gateway_id) VALUES ($1, $2)
         ON CONFLICT (device_id) DO NOTHING RETURNING device_id`,
        [m.device_id, m.gateway_id],
      );
      knownDevices.add(m.device_id);
      if (dev.rowCount === 1) {
        res.discovered.push(m.device_id);
        await client.query("SELECT pg_notify('fg_events', $1)", [
          JSON.stringify({ type: "device_discovered", device_id: m.device_id, gateway_id: m.gateway_id }),
        ]);
      }
    }

    // Invariant 1: one history row per (gateway, device, metric, sequence).
    const ins = await client.query(
      `INSERT INTO readings (gateway_id, device_id, metric, value, event_time, sequence, lane)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6, $7)
       ON CONFLICT ON CONSTRAINT readings_identity DO NOTHING
       RETURNING id`,
      [m.gateway_id, m.device_id, m.metric, value, m.event_time, m.sequence, m.lane],
    );
    if (ins.rowCount === 0) {
      // A resend (or a redelivery after a crash). Count it; never store it twice.
      const dup = await client.query(
        `UPDATE readings SET resend_count = resend_count + 1
          WHERE gateway_id = $1 AND device_id = $2 AND metric = $3 AND sequence = $4
          RETURNING id, (value = $5::jsonb AND event_time = $6::timestamptz) AS same`,
        [m.gateway_id, m.device_id, m.metric, m.sequence, value, m.event_time],
      );
      res.duplicates++;
      g.duplicates++;
      if (dup.rows[0] && !dup.rows[0].same) {
        // Same identity, different content: keep the first, surface the conflict.
        res.conflicts++;
        await client.query(
          `INSERT INTO anomalies (kind, gateway_id, device_id, detail) VALUES ('conflicting_resend', $1, $2, $3)`,
          [m.gateway_id, m.device_id, JSON.stringify({ kept_reading_id: dup.rows[0].id, rejected: m })],
        );
      }
      continue;
    }
    const readingId = ins.rows[0].id;
    res.inserted++;
    g.inserted++;
    changed.add(m.device_id);

    // Invariant 2: current state only moves forward in (event_time, gateway_id, sequence).
    const st = await client.query(
      `INSERT INTO device_metric_state (device_id, metric, value, event_time, gateway_id, sequence, reading_id)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5, $6, $7)
       ON CONFLICT (device_id, metric) DO UPDATE
         SET value = EXCLUDED.value, event_time = EXCLUDED.event_time, gateway_id = EXCLUDED.gateway_id,
             sequence = EXCLUDED.sequence, reading_id = EXCLUDED.reading_id, updated_at = now()
       WHERE (EXCLUDED.event_time, EXCLUDED.gateway_id, EXCLUDED.sequence)
           > (device_metric_state.event_time, device_metric_state.gateway_id, device_metric_state.sequence)
       RETURNING 1`,
      [m.device_id, m.metric, value, m.event_time, m.gateway_id, m.sequence, readingId],
    );
    if (st.rowCount === 0) {
      // Something equal-or-newer is already current: stored in history, not shown as current.
      await client.query("UPDATE readings SET late = true WHERE id = $1", [readingId]);
      res.late++;
      g.late++;
    }
  }

  for (const [gatewayId, g] of [...gateways].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    await client.query(
      `INSERT INTO gateways (gateway_id, last_seen_at, max_event_time, max_sequence, readings_total, duplicates_total, late_total)
       VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7)
       ON CONFLICT (gateway_id) DO UPDATE SET
         last_seen_at     = GREATEST(gateways.last_seen_at, EXCLUDED.last_seen_at),
         max_event_time   = GREATEST(gateways.max_event_time, EXCLUDED.max_event_time),
         max_sequence     = GREATEST(gateways.max_sequence, EXCLUDED.max_sequence),
         readings_total   = gateways.readings_total + EXCLUDED.readings_total,
         duplicates_total = gateways.duplicates_total + EXCLUDED.duplicates_total,
         late_total       = gateways.late_total + EXCLUDED.late_total`,
      [gatewayId, g.lastSeen, g.maxEvent, g.maxSeq, g.inserted, g.duplicates, g.late],
    );
  }

  res.changed = [...changed];
  if (res.changed.length) {
    // NOTIFY payloads are capped at 8000 bytes; for a big batch just ask browsers to refetch.
    let payload = JSON.stringify({ type: "state_changed", device_ids: res.changed });
    if (Buffer.byteLength(payload) > 7000) payload = JSON.stringify({ type: "refresh" });
    await client.query("SELECT pg_notify('fg_events', $1)", [payload]);
  }
  return res;
}
