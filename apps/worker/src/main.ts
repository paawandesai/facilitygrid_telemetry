import { Kafka, Partitioners, logLevel, type Consumer, type EachBatchPayload, type Producer } from "kafkajs";
import pg from "pg";
import { TOPICS, type ReadingMessage } from "@fg/shared";
import { isPoisonError, processBatch } from "./process.js";

pg.types.setTypeParser(20, (v) => Number(v));

const brokers = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://telemetry:telemetry@localhost:5432/telemetry",
  max: 10,
  options: "-c timezone=UTC",
});
const CHUNK = Number(process.env.WORKER_CHUNK ?? 500);

const kafka = new Kafka({
  clientId: "fg-worker",
  brokers,
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 300, retries: 10 },
});

const stats = { inserted: 0, duplicates: 0, late: 0, discovered: 0, dlq: 0 };

function parse(raw: Buffer | null): ReadingMessage | null {
  try {
    const m = JSON.parse(raw?.toString() ?? "");
    const ok =
      m &&
      typeof m.gateway_id === "string" &&
      typeof m.device_id === "string" &&
      typeof m.metric === "string" &&
      typeof m.event_time === "string" &&
      Number.isSafeInteger(m.sequence) &&
      typeof m.received_at === "string";
    return ok ? (m as ReadingMessage) : null;
  } catch {
    return null;
  }
}

async function toDlq(producer: Producer, raw: Buffer | null, reason: string, source: string) {
  await producer.send({
    topic: TOPICS.dlq,
    acks: -1,
    messages: [{ value: raw, headers: { reason, source } }],
  });
  await pool.query(`INSERT INTO anomalies (kind, detail) VALUES ('dead_letter', $1)`, [
    JSON.stringify({ reason, source, raw: raw?.toString().slice(0, 2000) ?? null }),
  ]);
  stats.dlq++;
}

function handler(producer: Producer, consumer: Consumer) {
  return async ({ batch, heartbeat, isRunning, isStale, resolveOffset }: EachBatchPayload) => {
    for (let i = 0; i < batch.messages.length; i += CHUNK) {
      if (!isRunning() || isStale()) return;
      const chunk = batch.messages.slice(i, i + CHUNK);
      const good: ReadingMessage[] = [];
      for (const msg of chunk) {
        const m = parse(msg.value);
        if (m) good.push(m);
        else await toDlq(producer, msg.value, "unparseable message", `${batch.topic}/${batch.partition}@${msg.offset}`);
      }

      try {
        const r = await processBatch(pool, good);
        stats.inserted += r.inserted;
        stats.duplicates += r.duplicates;
        stats.late += r.late;
        stats.discovered += r.discovered.length;
      } catch (err) {
        if (!isPoisonError(err)) throw err; // DB unavailable etc.: do not commit; redeliver later.
        // Some message in the chunk can never be written. Isolate it so the rest still land.
        for (const m of good) {
          try {
            await processBatch(pool, [m]);
          } catch (e) {
            if (!isPoisonError(e)) throw e;
            await toDlq(producer, Buffer.from(JSON.stringify(m)), (e as Error).message, batch.topic);
          }
        }
      }

      // Offsets are committed only after the database transaction committed.
      // A crash between the two means redelivery, which the unique keys absorb.
      const last = chunk[chunk.length - 1];
      await consumer.commitOffsets([
        { topic: batch.topic, partition: batch.partition, offset: (BigInt(last.offset) + 1n).toString() },
      ]);
      resolveOffset(last.offset);
      await heartbeat();
    }
  };
}

async function startLane(topic: string, groupId: string, producer: Producer) {
  const consumer = kafka.consumer({ groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000 });
  consumer.on(consumer.events.CRASH, (e) => {
    console.error(`consumer ${groupId} crashed`, e.payload.error);
    if (!e.payload.restart) process.exit(1);
  });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: 3,
    eachBatch: handler(producer, consumer),
  });
  return consumer;
}

async function ensureTopics() {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: TOPICS.live, numPartitions: 6, replicationFactor: 1 },
        { topic: TOPICS.backlog, numPartitions: 6, replicationFactor: 1 },
        { topic: TOPICS.dlq, numPartitions: 1, replicationFactor: 1 },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 60) throw err;
      console.warn(`${what} not ready (${(err as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  await retry("postgres", () => pool.query("SELECT 1 FROM readings LIMIT 1"));
  await retry("redpanda", ensureTopics);
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  await retry("producer", () => producer.connect());

  // Two lanes, two consumer groups: an hour-long backlog replay is consumed
  // independently and never sits in front of other gateways' live readings.
  const consumers = [
    await startLane(TOPICS.live, "fg-worker-live", producer),
    await startLane(TOPICS.backlog, "fg-worker-backlog", producer),
  ];
  console.log("worker: consuming", TOPICS.live, "and", TOPICS.backlog);

  const timer = setInterval(() => {
    if (stats.inserted || stats.duplicates || stats.dlq) console.log("worker:", JSON.stringify(stats));
  }, 10_000);

  const shutdown = async () => {
    clearInterval(timer);
    await Promise.allSettled(consumers.map((c) => c.disconnect()));
    await producer.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
