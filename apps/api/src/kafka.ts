import { Kafka, Partitioners, logLevel, type Producer } from "kafkajs";
import { TOPICS } from "@fg/shared";
import { config } from "./config.js";

export const kafka = new Kafka({
  clientId: "fg-api",
  brokers: config.kafkaBrokers,
  logLevel: logLevel.WARN,
  connectionTimeout: 2000,
  requestTimeout: 5000,
  retry: { initialRetryTime: 200, retries: 4, maxRetryTime: 2000 },
});

export async function ensureTopics() {
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

export let producerReady = false;

export function createProducer(): Producer {
  // acks=all is set per send. Duplicates from producer retries are absorbed by
  // the readings_identity unique key, so the database, not the producer, is
  // what guarantees "no duplicates".
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  producer.on(producer.events.CONNECT, () => (producerReady = true));
  producer.on(producer.events.DISCONNECT, () => (producerReady = false));
  return producer;
}
