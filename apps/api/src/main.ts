import { config } from "./config.js";
import { createProducer, ensureTopics } from "./kafka.js";
import { migrate } from "./migrate.js";
import { buildApp } from "./server.js";
import { EventHub } from "./events.js";
import { pool } from "./db.js";

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 60): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`${what} not ready (${(err as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  if (process.env.RUN_MIGRATIONS !== "false") await retry("postgres", () => migrate());
  await retry("redpanda", () => ensureTopics());
  const producer = createProducer();
  await retry("producer", () => producer.connect());

  const hub = new EventHub();
  void hub.start();
  const app = buildApp(producer, hub);
  await app.listen({ port: config.port, host: "0.0.0.0" });

  const shutdown = async () => {
    await app.close();
    await hub.stop();
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
