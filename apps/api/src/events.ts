import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import pg from "pg";
import { config } from "./config.js";

/**
 * Server-Sent Events fed by Postgres LISTEN/NOTIFY. The worker calls
 * pg_notify inside its transaction, so a browser only hears about state that
 * has actually committed.
 */
export class EventHub {
  private clients = new Set<ServerResponse>();
  private client: pg.Client | null = null;
  private stopped = false;

  async start() {
    while (!this.stopped) {
      try {
        const client = new pg.Client({ connectionString: config.databaseUrl });
        client.on("notification", (n) => n.payload && this.broadcast(n.payload));
        const closed = new Promise<void>((resolve) => {
          client.on("error", () => resolve());
          client.on("end", () => resolve());
        });
        await client.connect();
        await client.query("LISTEN fg_events");
        this.client = client;
        // Anything missed while disconnected: tell browsers to refetch.
        this.broadcast(JSON.stringify({ type: "refresh" }));
        await closed;
      } catch {
        /* retry below */
      }
      this.client = null;
      if (!this.stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async stop() {
    this.stopped = true;
    for (const c of this.clients) c.end();
    await this.client?.end().catch(() => {});
  }

  broadcast(payload: string) {
    for (const c of this.clients) c.write(`data: ${payload}\n\n`);
  }

  register(app: FastifyInstance) {
    app.get("/events", (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`retry: 2000\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
      req.raw.on("close", () => {
        clearInterval(ping);
        this.clients.delete(res);
      });
    });
  }
}
