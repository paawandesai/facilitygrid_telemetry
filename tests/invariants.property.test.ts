// The centrepiece: random readings, delivered shuffled, duplicated and split
// across the live and backlog lanes, through the real HTTP endpoint. After the
// pipeline settles, Postgres must match a simple oracle computed in memory.
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareReadings } from "@fg/shared";
import { db, listenDiscoveries, post, settle, shuffle, uniq, type WireReading } from "./helpers.js";

const METRICS = ["supply_temp", "power_kw", "status"];

const scenario = fc.record({
  gateways: fc.integer({ min: 1, max: 3 }),
  devices: fc.integer({ min: 1, max: 4 }),
  readings: fc.array(
    fc.record({
      gw: fc.nat(),
      dev: fc.nat(),
      metric: fc.nat(),
      // A mix of live (< 60s old) and backlog (up to 2h old) readings, with
      // some exact event_time ties to exercise the (gateway, sequence) tie-break.
      offsetSec: fc.oneof(fc.constantFrom(0, -30, -3600), fc.integer({ min: -7200, max: 0 })),
      value: fc.oneof(fc.integer({ min: -50, max: 150 }), fc.constantFrom("running", "stopped")),
    }),
    { minLength: 1, maxLength: 60 },
  ),
  copies: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 60, maxLength: 60 }),
  chunkSizes: fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 200, maxLength: 200 }),
  seed: fc.integer(),
});

afterAll(() => db.end());

describe("invariants under shuffled, duplicated, split delivery", () => {
  it("history, current state, registration and late flags match the oracle", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const prefix = uniq("prop");
        const now = Date.now() - 1000;
        const seq = new Map<string, number>();

        // Distinct readings. Sequence numbers count per gateway, as a gateway would.
        const readings: WireReading[] = s.readings.map((r) => {
          const gateway_id = `${prefix}-gw${r.gw % s.gateways}`;
          const n = (seq.get(gateway_id) ?? 0) + 1;
          seq.set(gateway_id, n);
          return {
            gateway_id,
            device_id: `${prefix}-dev${r.dev % s.devices}`,
            metric: METRICS[r.metric % METRICS.length],
            value: r.value,
            event_time: new Date(now + r.offsetSec * 1000).toISOString(),
            sequence: n,
          };
        });

        // Delivery: every reading 1-4 times, in random order, in random-sized requests.
        let x = s.seed;
        const rand = () => ((x = (Math.imul(x, 1103515245) + 12345) | 0) >>> 0) / 2 ** 32;
        const stream = shuffle(
          readings.flatMap((r, i) => Array.from({ length: s.copies[i % s.copies.length] }, () => r)),
          rand,
        );
        const requests: WireReading[][] = [];
        for (let i = 0, c = 0; i < stream.length; c++) {
          const size = s.chunkSizes[c % s.chunkSizes.length];
          requests.push(stream.slice(i, i + size));
          i += size;
        }

        const discoveries = await listenDiscoveries(prefix);
        try {
          // Sequential, so the arrival order (which defines `late`) is known.
          for (const body of requests) {
            const res = await post(body.length === 1 ? body[0] : body);
            expect(res.status).toBe(202);
          }
          await settle(prefix, readings.length);

          // ---------- the oracle ----------
          const key = (r: WireReading) => `${r.gateway_id}|${r.device_id}|${r.metric}|${r.sequence}`;
          const ord = (r: WireReading) => ({ event_time_ms: Date.parse(r.event_time), gateway_id: r.gateway_id, sequence: r.sequence });
          const firstArrival = new Map<string, number>();
          stream.forEach((r, i) => firstArrival.has(key(r)) || firstArrival.set(key(r), i));

          // Invariant 1: each distinct reading exactly once, with its own content.
          const { rows: stored } = await db.query(
            `SELECT gateway_id, device_id, metric, sequence, value, event_time, resend_count, late
               FROM readings WHERE device_id LIKE $1`,
            [`${prefix}%`],
          );
          expect(stored.length).toBe(readings.length);
          const byKey = new Map(stored.map((r) => [key(r), r]));
          for (const r of readings) {
            const row = byKey.get(key(r));
            expect(row, `missing ${key(r)}`).toBeDefined();
            expect(row.value).toEqual(r.value);
            expect(row.event_time.getTime()).toBe(Date.parse(r.event_time));
          }
          const resends = stored.reduce((a, r) => a + r.resend_count, 0);
          expect(resends).toBe(stream.length - readings.length);

          // Invariant 2: current state is the max by (event_time, gateway_id, sequence).
          const expected = new Map<string, WireReading>();
          for (const r of readings) {
            const k = `${r.device_id}|${r.metric}`;
            const cur = expected.get(k);
            if (!cur || compareReadings(ord(r), ord(cur)) > 0) expected.set(k, r);
          }
          const { rows: state } = await db.query(
            `SELECT device_id, metric, value, event_time, gateway_id, sequence
               FROM device_metric_state WHERE device_id LIKE $1`,
            [`${prefix}%`],
          );
          expect(state.length).toBe(expected.size);
          for (const st of state) {
            const want = expected.get(`${st.device_id}|${st.metric}`)!;
            expect({ gw: st.gateway_id, seq: st.sequence, value: st.value }).toEqual({
              gw: want.gateway_id,
              seq: want.sequence,
              value: want.value,
            });
          }

          // Invariant 3: every device registered exactly once, announced exactly once.
          const devices = new Set(readings.map((r) => r.device_id));
          const { rows: devRows } = await db.query("SELECT device_id FROM devices WHERE device_id LIKE $1", [`${prefix}%`]);
          expect(devRows.map((d) => d.device_id).sort()).toEqual([...devices].sort());
          expect([...discoveries.seen].sort()).toEqual([...devices].sort());

          // Late: arrived after a reading with a newer (event_time, gateway, seq)
          // for the same device and metric had already arrived.
          for (const r of readings) {
            const isLate = readings.some(
              (o) =>
                o.device_id === r.device_id &&
                o.metric === r.metric &&
                firstArrival.get(key(o))! < firstArrival.get(key(r))! &&
                compareReadings(ord(o), ord(r)) > 0,
            );
            expect(byKey.get(key(r)).late, `late flag of ${key(r)}`).toBe(isLate);
          }
        } finally {
          await discoveries.close();
        }
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 15), endOnFailure: true },
    );
  });
});
