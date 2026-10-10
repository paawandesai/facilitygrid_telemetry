// Shared helpers for the invariant tests. They run against the real stack
// (docker compose -f docker-compose.yml -f docker-compose.dev.yml up): HTTP into the API, through Redpanda and the worker,
// then read Postgres directly to check what was actually stored.
import pg from "pg";
import { randomUUID } from "node:crypto";

// Host ports come from docker-compose.dev.yml (same env vars, same defaults).
export const API = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 13000}`;
export const DATABASE_URL =
  process.env.DATABASE_URL ?? `postgres://telemetry:telemetry@localhost:${process.env.POSTGRES_PORT ?? 15432}/telemetry`;

pg.types.setTypeParser(20, (v) => Number(v));
export const db = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

export interface WireReading {
  gateway_id: string;
  device_id: string;
  metric: string;
  value: unknown;
  event_time: string;
  sequence: number;
}

/** A unique prefix per test run, so tests never need to wipe the database. */
export const uniq = (label: string) => `t-${label}-${randomUUID().slice(0, 8)}`;

export async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}/ingest/readings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Posts like a well-behaved gateway: retries on 503 until accepted. */
export async function postUntilAccepted(body: unknown, maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    let status = 0;
    try {
      status = (await post(body)).status;
    } catch {
      /* connection refused while the API restarts */
    }
    if (status === 202) return;
    if (status !== 503 && status !== 0) throw new Error(`unexpected HTTP ${status}`);
    if (Date.now() > deadline) throw new Error("gave up retrying");
    await sleep(300);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
    await sleep(200);
  }
}

/** Waits until the stored row count for a prefix reaches `expected` and stays put (late duplicates included). */
export async function settle(prefix: string, expected: number) {
  await waitFor(`${expected} readings for ${prefix}`, async () => {
    const n = await countReadings(prefix);
    return n >= expected;
  });
  // Give any in-flight duplicates time to land so assertions see the final state.
  await waitForQuiet(prefix);
}

async function waitForQuiet(prefix: string) {
  let prev = "";
  for (let stableFor = 0; stableFor < 3; ) {
    const { rows } = await db.query(
      `SELECT count(*) AS n, coalesce(sum(resend_count), 0)::bigint AS d, count(*) FILTER (WHERE late) AS l
         FROM readings WHERE device_id LIKE $1`,
      [`${prefix}%`],
    );
    const cur = JSON.stringify(rows[0]);
    stableFor = cur === prev ? stableFor + 1 : 0;
    prev = cur;
    await sleep(400);
  }
}

export async function countReadings(prefix: string): Promise<number> {
  const { rows } = await db.query("SELECT count(*) AS n FROM readings WHERE device_id LIKE $1", [`${prefix}%`]);
  return rows[0].n;
}

/** Collects device_discovered notifications for devices under a prefix. */
export async function listenDiscoveries(prefix: string) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const seen: string[] = [];
  client.on("notification", (n) => {
    const e = JSON.parse(n.payload ?? "{}");
    if (e.type === "device_discovered" && e.device_id.startsWith(prefix)) seen.push(e.device_id);
  });
  await client.query("LISTEN fg_events");
  return { seen, close: () => client.end() };
}

export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
