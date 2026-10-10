import Fastify from "fastify";
import type { Producer } from "kafkajs";
import { registerIngest } from "./ingest.js";
import { registerRoutes } from "./routes.js";
import { registerAnalysis } from "./analysis.js";
import { EventHub } from "./events.js";
import { pool } from "./db.js";
import { producerReady } from "./kafka.js";

export function buildApp(producer: Producer, hub: EventHub) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  // Gateways in the field do not always set Content-Type. Treat any body as JSON
  // rather than rejecting readings over a header.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body).trim();
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("body is not valid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
    } catch {
      return reply.code(503).send({ ok: false, db: false, broker: producerReady });
    }
    return { ok: true, db: true, broker: producerReady };
  });

  registerIngest(app, producer);
  registerRoutes(app);
  registerAnalysis(app);
  hub.register(app);
  return app;
}
