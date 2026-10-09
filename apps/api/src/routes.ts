import type { FastifyInstance } from "fastify";
import { ClaimInput, type DeviceSummary, type GatewaySummary, type MetricState, type ReadingRow } from "@fg/shared";
import { config } from "./config.js";
import { pool } from "./db.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function loadDevices(where: string, params: unknown[]): Promise<DeviceSummary[]> {
  const { rows } = await pool.query(
    `SELECT d.*,
            coalesce(r.reading_count, 0) AS reading_count,
            coalesce(r.gateways, '{}')   AS gateways
       FROM devices d
       LEFT JOIN LATERAL (
         SELECT count(*) AS reading_count, array_agg(DISTINCT gateway_id) AS gateways
           FROM readings WHERE device_id = d.device_id
       ) r ON true
      ${where}
      ORDER BY d.first_seen_at DESC, d.device_id`,
    params,
  );
  if (rows.length === 0) return [];

  const { rows: states } = await pool.query(
    `SELECT s.*, g.last_seen_at AS gateway_last_seen_at
       FROM device_metric_state s
       LEFT JOIN gateways g USING (gateway_id)
      WHERE s.device_id = ANY($1)
      ORDER BY s.metric`,
    [rows.map((r) => r.device_id)],
  );
  const now = Date.now();
  const metrics = new Map<string, MetricState[]>();
  for (const s of states) {
    const m: MetricState = {
      metric: s.metric,
      value: s.value,
      event_time: s.event_time.toISOString(),
      gateway_id: s.gateway_id,
      sequence: s.sequence,
      updated_at: s.updated_at.toISOString(),
      stale: !s.gateway_last_seen_at || now - s.gateway_last_seen_at.getTime() > config.staleAfterMs,
    };
    if (!metrics.has(s.device_id)) metrics.set(s.device_id, []);
    metrics.get(s.device_id)!.push(m);
  }

  return rows.map((d) => ({
    device_id: d.device_id,
    status: d.status,
    name: d.name,
    equipment_type: d.equipment_type,
    location: d.location,
    first_seen_at: d.first_seen_at.toISOString(),
    first_seen_gateway_id: d.first_seen_gateway_id,
    claimed_at: iso(d.claimed_at),
    claimed_by: d.claimed_by,
    gateways: d.gateways,
    reading_count: d.reading_count,
    metrics: metrics.get(d.device_id) ?? [],
  }));
}

export function registerRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>("/devices", async (req, reply) => {
    const status = req.query.status;
    if (status && status !== "claimed" && status !== "unclaimed") {
      return reply.code(400).send({ error: "status must be claimed or unclaimed" });
    }
    return status ? loadDevices("WHERE d.status = $1", [status]) : loadDevices("", []);
  });

  app.get<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
    const [device] = await loadDevices("WHERE d.device_id = $1", [req.params.id]);
    if (!device) return reply.code(404).send({ error: "not_found" });
    return device;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/devices/:id/readings", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 500) || 500, 5000);
    const { rows } = await pool.query(
      `SELECT id, gateway_id, metric, value, event_time, sequence, ingested_at, lane, resend_count, late
         FROM readings WHERE device_id = $1
        ORDER BY event_time DESC, gateway_id DESC, sequence DESC
        LIMIT $2`,
      [req.params.id, limit],
    );
    return rows.map(
      (r): ReadingRow => ({ ...r, event_time: r.event_time.toISOString(), ingested_at: r.ingested_at.toISOString() }),
    );
  });

  // Claiming is a compare-and-set: only one of two simultaneous claims can
  // flip status from 'unclaimed', the other gets 409.
  app.post<{ Params: { id: string } }>("/devices/:id/claim", async (req, reply) => {
    const parsed = ClaimInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_claim", details: parsed.error.issues });
    const c = parsed.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE devices
            SET status = 'claimed', name = $2, equipment_type = $3, location = $4,
                claimed_by = $5, claimed_at = now()
          WHERE device_id = $1 AND status = 'unclaimed'
        RETURNING device_id`,
        [req.params.id, c.name, c.equipment_type ?? null, c.location ?? null, c.claimed_by ?? null],
      );
      if (rows.length === 1) {
        await client.query("SELECT pg_notify('fg_events', $1)", [
          JSON.stringify({ type: "device_claimed", device_id: req.params.id }),
        ]);
      }
      await client.query("COMMIT");
      if (rows.length === 0) {
        const exists = await pool.query("SELECT 1 FROM devices WHERE device_id = $1", [req.params.id]);
        return exists.rowCount
          ? reply.code(409).send({ error: "already_claimed" })
          : reply.code(404).send({ error: "not_found" });
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const [device] = await loadDevices("WHERE d.device_id = $1", [req.params.id]);
    return device;
  });

  app.get("/gateways", async (): Promise<GatewaySummary[]> => {
    const { rows } = await pool.query("SELECT * FROM gateways ORDER BY gateway_id");
    const now = Date.now();
    return rows.map((g) => {
      const silent = now - g.last_seen_at.getTime();
      return {
        gateway_id: g.gateway_id,
        last_seen_at: g.last_seen_at.toISOString(),
        max_event_time: g.max_event_time.toISOString(),
        max_sequence: g.max_sequence,
        readings_total: g.readings_total,
        duplicates_total: g.duplicates_total,
        late_total: g.late_total,
        online: silent <= config.staleAfterMs,
        silent_for_ms: silent,
      };
    });
  });

  app.get("/anomalies", async () => {
    const { rows } = await pool.query("SELECT * FROM anomalies ORDER BY created_at DESC, id DESC LIMIT 100");
    return rows;
  });

  app.get("/stats", async () => {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM devices)                              AS devices,
             (SELECT count(*) FROM devices WHERE status = 'unclaimed')   AS unclaimed,
             (SELECT count(*) FROM readings)                             AS readings,
             (SELECT coalesce(sum(resend_count), 0)::bigint FROM readings) AS duplicates_absorbed,
             (SELECT count(*) FROM readings WHERE late)                  AS late,
             (SELECT count(*) FROM anomalies)                            AS anomalies`);
    return { ...rows[0], stale_after_ms: config.staleAfterMs };
  });
}
