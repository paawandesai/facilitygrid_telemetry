// The spec's reconnect story: a gateway goes dark, keeps buffering, then dumps
// an hour of backlog, including readings it had already delivered, while
// another gateway's live data keeps flowing. History must be exact and the
// current state must never move backwards.
import { afterAll, describe, expect, it } from "vitest";
import { db, post, settle, uniq } from "./helpers.js";

afterAll(() => db.end());

describe("backlog replay", () => {
  it("absorbs resends, keeps the newer state, and flags the backlog late", async () => {
    const prefix = uniq("replay");
    const device = `${prefix}-ahu`;
    const gw = `${prefix}-gw1`;
    const now = Date.now() - 1000;
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const reading = (seq: number, minAgo: number, value: number) => ({
      gateway_id: gw, device_id: device, metric: "supply_temp", value, event_time: at(minAgo), sequence: seq,
    });

    // Before the outage: seq 1..5 delivered (60..56 minutes ago).
    const before = [1, 2, 3, 4, 5].map((s) => reading(s, 61 - s, 10 + s));
    expect((await post(before)).status).toBe(202);

    // During the outage another path (say a second gateway) delivers a fresh reading.
    expect((await post({ ...reading(1, 0, 99), gateway_id: `${prefix}-gw2` })).status).toBe(202);

    // Reconnect: seq 3..60 replayed in one dump; 3..5 are resends.
    const backlog = Array.from({ length: 58 }, (_, i) => i + 3).map((s) => reading(s, 61 - s, 10 + s));
    expect((await post(backlog)).status).toBe(202);
    await settle(prefix, 61);

    const { rows } = await db.query(
      `SELECT sequence, gateway_id, resend_count, late, lane FROM readings WHERE device_id = $1 ORDER BY gateway_id, sequence`,
      [device],
    );
    expect(rows.length).toBe(61); // 60 from gw1 + 1 from gw2, no duplicates
    const gw1 = rows.filter((r) => r.gateway_id === gw);
    expect(gw1.filter((r) => r.resend_count === 1).map((r) => r.sequence)).toEqual([3, 4, 5]);
    // Everything gw1 replayed after gw2's fresh reading arrived is flagged late,
    // and it all went through the backlog lane.
    expect(gw1.filter((r) => r.late).map((r) => r.sequence)).toEqual(backlog.map((r) => r.sequence).filter((s) => s > 5));
    expect(new Set(gw1.map((r) => r.lane))).toEqual(new Set(["backlog"]));

    const { rows: state } = await db.query(
      "SELECT value, gateway_id FROM device_metric_state WHERE device_id = $1",
      [device],
    );
    expect(state).toEqual([{ value: 99, gateway_id: `${prefix}-gw2` }]);
  });

  it("keeps the first copy when a resend carries different content, and records an anomaly", async () => {
    const prefix = uniq("conflict");
    const r = { gateway_id: `${prefix}-gw`, device_id: `${prefix}-dev`, metric: "temp", value: 20, event_time: new Date().toISOString(), sequence: 7 };
    expect((await post(r)).status).toBe(202);
    await settle(prefix, 1);
    expect((await post({ ...r, value: 25 })).status).toBe(202);
    await settle(prefix, 1);
    const { rows } = await db.query("SELECT value, resend_count FROM readings WHERE device_id = $1", [r.device_id]);
    expect(rows).toEqual([{ value: 20, resend_count: 1 }]);
    const { rows: anomalies } = await db.query("SELECT kind FROM anomalies WHERE device_id = $1", [r.device_id]);
    expect(anomalies).toEqual([{ kind: "conflicting_resend" }]);
  });

  it("rejects malformed and far-future readings without storing anything", async () => {
    const prefix = uniq("reject");
    const ok = { gateway_id: `${prefix}-gw`, device_id: `${prefix}-dev`, metric: "temp", value: 1, event_time: new Date().toISOString(), sequence: 1 };
    expect((await post({ ...ok, sequence: undefined })).status).toBe(400);
    expect((await post({ ...ok, event_time: "not a time" })).status).toBe(400);
    // One bad reading rejects the whole request, so nothing is half-accepted.
    expect((await post([ok, { ...ok, sequence: 2, device_id: "" }])).status).toBe(400);
    expect((await post({ ...ok, event_time: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(422);
    await new Promise((r) => setTimeout(r, 1500));
    const { rows } = await db.query("SELECT count(*) AS n FROM readings WHERE device_id LIKE $1", [`${prefix}%`]);
    expect(rows[0].n).toBe(0);
  });
});
