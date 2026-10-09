import type { FastifyInstance } from "fastify";
import type { Producer, Message } from "kafkajs";
import {
  MAX_FUTURE_SKEW_MS,
  ReadingInput,
  TOPICS,
  chooseLane,
  type Reading,
  type ReadingMessage,
} from "@fg/shared";
import { config } from "./config.js";

const MAX_BATCH = 1000;
const REQUIRED = ["gateway_id", "device_id", "metric", "value", "event_time", "sequence"] as const;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`broker did not ack within ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * POST /ingest/readings
 *
 * 202 means the reading is durably on the broker (acks=all). Nothing that was
 * acknowledged lives only in this process's memory. If the broker cannot be
 * reached we answer 503 and the gateway keeps it buffered and retries; if the
 * broker in fact stored it before we gave up, the retry is a duplicate that the
 * database's unique key absorbs.
 */
export function registerIngest(app: FastifyInstance, producer: Producer) {
  app.post("/ingest/readings", async (req, reply) => {
    const body = req.body;
    const items: unknown[] = Array.isArray(body) ? body : [body];
    if (items.length === 0 || items.length > MAX_BATCH) {
      return reply.code(400).send({ error: "invalid_body", message: `send 1..${MAX_BATCH} readings` });
    }

    const readings: Reading[] = [];
    const issues: { index: number; issues: unknown }[] = [];
    items.forEach((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        issues.push({ index, issues: [{ path: "", message: "expected a JSON object" }] });
        return;
      }
      const missing = REQUIRED.filter((k) => !(k in item));
      if (missing.length) {
        issues.push({ index, issues: missing.map((k) => ({ path: k, message: "required" })) });
        return;
      }
      const r = ReadingInput.safeParse(item);
      if (r.success) readings.push(r.data);
      else issues.push({ index, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    });
    // All-or-nothing: a request is either fully accepted or fully rejected, so a
    // gateway never has to work out which half of a batch got in.
    if (issues.length) return reply.code(400).send({ error: "invalid_reading", details: issues });

    const now = Date.now();
    const future = readings.filter((r) => r.event_time_ms - now > MAX_FUTURE_SKEW_MS);
    if (future.length) {
      req.log.warn({ gateway_id: future[0].gateway_id, event_time: future[0].event_time }, "event_time in the future");
      return reply.code(422).send({
        error: "event_time_in_future",
        message: `event_time more than ${MAX_FUTURE_SKEW_MS / 1000}s ahead of server time; check the gateway clock`,
      });
    }

    const receivedAt = new Date(now).toISOString();
    const byTopic = new Map<string, Message[]>();
    for (const [i, r] of readings.entries()) {
      const lane = chooseLane(r.event_time_ms, now);
      const msg: ReadingMessage = {
        gateway_id: r.gateway_id,
        device_id: r.device_id,
        metric: r.metric,
        value: r.value,
        event_time: r.event_time,
        sequence: r.sequence,
        received_at: receivedAt,
        arrival_idx: i,
        lane,
      };
      const topic = lane === "live" ? TOPICS.live : TOPICS.backlog;
      // Keyed by device so one device's readings share a partition (an
      // optimisation; correctness comes from the database constraints).
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic)!.push({ key: r.device_id, value: JSON.stringify(msg) });
    }

    try {
      await withTimeout(
        producer.sendBatch({
          acks: -1,
          topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
        }),
        config.produceTimeoutMs,
      );
    } catch (err) {
      req.log.error({ err }, "produce failed");
      return reply
        .code(503)
        .header("Retry-After", "1")
        .send({ error: "broker_unavailable", message: "not accepted; retry later" });
    }

    return reply.code(202).send({ accepted: readings.length });
  });
}
