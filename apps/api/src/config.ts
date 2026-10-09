import { DEFAULT_STALE_AFTER_MS } from "@fg/shared";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://telemetry:telemetry@localhost:5432/telemetry",
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? "localhost:19092").split(","),
  staleAfterMs: Number(process.env.STALE_AFTER_MS ?? DEFAULT_STALE_AFTER_MS),
  /** Upper bound on how long a gateway waits for its 202 before we answer 503. */
  produceTimeoutMs: Number(process.env.PRODUCE_TIMEOUT_MS ?? 8000),
  migrationsDir: process.env.MIGRATIONS_DIR ?? new URL("../../../db/migrations", import.meta.url).pathname,
};
