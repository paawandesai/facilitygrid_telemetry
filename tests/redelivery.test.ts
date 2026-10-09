// The worker's crash window, tested directly: if it dies after the database
// commit but before the Kafka offset commit, the broker hands it the same batch
// again. And with two lanes or two replicas, overlapping batches can be written
// concurrently. Both must converge to exactly the same database state.
import { afterAll, describe, expect, it } from "vitest";
import type { ReadingMessage } from "@fg/shared";
import { processBatch } from "../apps/worker/src/process.js";
import { db, uniq } from "./helpers.js";

afterAll(() => db.end());

function makeBatch(prefix: string, n: number): ReadingMessage[] {
  const t0 = Date.now() - 10_000;
  return Array.from({ length: n }, (_, i) => ({
    gateway_id: `${prefix}-gw${i % 2}`,
    device_id: `${prefix}-dev${i % 5}`,
    metric: ["a", "b"][i % 2],
    value: i,
    event_time: new Date(t0 - ((i * 7919) % 50) * 1000).toISOString(),
    sequence: i,
    received_at: new Date(t0 + i).toISOString(),
    arrival_idx: 0,
    lane: "live",
  }));
}

async function snapshot(prefix: string) {
  const q = async (sql: string) => (await db.query(sql, [`${prefix}%`])).rows;
  return {
    readings: await q(
      "SELECT gateway_id, device_id, metric, sequence, value, late FROM readings WHERE device_id LIKE $1 ORDER BY 1,2,3,4",
    ),
    state: await q("SELECT device_id, metric, gateway_id, sequence FROM device_metric_state WHERE device_id LIKE $1 ORDER BY 1,2"),
    devices: await q("SELECT device_id FROM devices WHERE device_id LIKE $1 ORDER BY 1"),
  };
}

describe("worker redelivery and concurrency", () => {
  it("processing the same batch twice changes nothing but the resend counters", async () => {
    const prefix = uniq("redeliver");
    const batch = makeBatch(prefix, 200);
    const first = await processBatch(db, batch);
    expect(first.inserted).toBe(200);
    const before = await snapshot(prefix);
    const second = await processBatch(db, batch);
    expect(second).toMatchObject({ inserted: 0, duplicates: 200, discovered: [] });
    expect(await snapshot(prefix)).toEqual(before);
  });

  it("overlapping batches written concurrently converge to the sequential result", async () => {
    const seqPrefix = uniq("seq");
    const conPrefix = uniq("con");
    const rename = (b: ReadingMessage[], from: string, to: string) =>
      b.map((m) => ({ ...m, gateway_id: m.gateway_id.replace(from, to), device_id: m.device_id.replace(from, to) }));

    const base = makeBatch("P", 300);
    await processBatch(db, rename(base, "P", seqPrefix));

    // Four overlapping slices racing each other, like lanes and replicas would.
    const slices = [base.slice(0, 200), base.slice(100, 300), base.slice(50, 250).reverse(), base];
    await Promise.all(slices.map((s) => processBatch(db, rename(s, "P", conPrefix))));

    const a = await snapshot(seqPrefix);
    const b = await snapshot(conPrefix);
    const strip = (s: typeof a, p: string) => JSON.parse(JSON.stringify(s).replaceAll(p, "X"));
    expect(strip(b, conPrefix)).toEqual(strip(a, seqPrefix));
  });
});
