// Invariant 3 under a deliberate race: two gateways report the same brand-new
// device at the same moment. One report is stamped an hour ago so it rides the
// backlog lane and the other the live lane: two different consumers write them
// concurrently. The device must be registered exactly once and announced once.
import { afterAll, describe, expect, it } from "vitest";
import { API, db, listenDiscoveries, post, settle, uniq } from "./helpers.js";

afterAll(() => db.end());

describe("registration race", () => {
  it("registers each new device exactly once when two gateways race", async () => {
    const prefix = uniq("race");
    const discoveries = await listenDiscoveries(prefix);
    const DEVICES = 40;
    const now = Date.now() - 1000;
    try {
      const requests = [];
      for (let d = 0; d < DEVICES; d++) {
        const device_id = `${prefix}-dev${d}`;
        for (const [gw, ageMs] of [["gw-a", 0], ["gw-b", 3_600_000]] as const) {
          const body = {
            gateway_id: `${prefix}-${gw}`,
            device_id,
            metric: "temp",
            value: d,
            event_time: new Date(now - ageMs).toISOString(),
            sequence: d,
          };
          // Each gateway also resends its report, as a flaky gateway would.
          requests.push(post(body), post(body));
        }
      }
      const statuses = (await Promise.all(requests)).map((r) => r.status);
      expect(new Set(statuses)).toEqual(new Set([202]));
      await settle(prefix, DEVICES * 2);

      const { rows } = await db.query(
        "SELECT device_id, count(*) OVER (PARTITION BY device_id) AS n FROM devices WHERE device_id LIKE $1",
        [`${prefix}%`],
      );
      expect(rows.length).toBe(DEVICES);
      expect(rows.every((r) => r.n === 1)).toBe(true);
      expect(discoveries.seen.length).toBe(DEVICES);
      expect(new Set(discoveries.seen).size).toBe(DEVICES);

      // Both gateways' readings are kept, once each; the live one is current.
      const { rows: readings } = await db.query(
        "SELECT count(*) AS n, sum(resend_count)::int AS resends FROM readings WHERE device_id LIKE $1",
        [`${prefix}%`],
      );
      expect(readings[0]).toEqual({ n: DEVICES * 2, resends: DEVICES * 2 });
      const { rows: state } = await db.query(
        "SELECT DISTINCT gateway_id FROM device_metric_state WHERE device_id LIKE $1",
        [`${prefix}%`],
      );
      expect(state).toEqual([{ gateway_id: `${prefix}-gw-a` }]);
    } finally {
      await discoveries.close();
    }
  });

  it("lets exactly one of several simultaneous claims win", async () => {
    const prefix = uniq("claim");
    const device_id = `${prefix}-dev`;
    await post({ gateway_id: `${prefix}-gw`, device_id, metric: "temp", value: 1, event_time: new Date().toISOString(), sequence: 1 });
    await settle(prefix, 1);

    const claim = (i: number) =>
      fetch(`${API}/devices/${device_id}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `claimant ${i}`, claimed_by: `user-${i}` }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(i)));

    const winners = results.filter((r) => r.status === 200);
    expect(winners.length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(9);
    const { rows } = await db.query("SELECT status, name FROM devices WHERE device_id = $1", [device_id]);
    expect(rows[0]).toEqual({ status: "claimed", name: winners[0].body.name });
  });
});
