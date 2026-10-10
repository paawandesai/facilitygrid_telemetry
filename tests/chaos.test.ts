// Failure injection against the compose stack. Opt-in (CHAOS=1) because it
// kills containers: `npm run test:chaos` with the stack running.
import { execSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { db, post, postUntilAccepted, settle, sleep, uniq } from "./helpers.js";

const compose = (args: string) => execSync(`docker compose -f docker-compose.yml -f docker-compose.dev.yml ${args}`, { stdio: "pipe" }).toString();

afterAll(() => db.end());

function batches(prefix: string, total: number, size: number) {
  const now = Date.now() - 1000;
  const out = [];
  for (let i = 0; i < total; i += size) {
    out.push(
      Array.from({ length: Math.min(size, total - i) }, (_, j) => {
        const n = i + j;
        return {
          gateway_id: `${prefix}-gw${n % 3}`,
          device_id: `${prefix}-dev${n % 25}`,
          metric: ["temp", "power", "vibration"][n % 3],
          value: n,
          // Spread over the last two hours so both lanes are busy.
          event_time: new Date(now - (n % 7) * 1_200_000 - n).toISOString(),
          sequence: n,
        };
      }),
    );
  }
  return out;
}

describe.runIf(process.env.CHAOS === "1")("failure injection", () => {
  it("loses and duplicates nothing when the worker is killed mid-stream", async () => {
    const prefix = uniq("crash");
    const reqs = batches(prefix, 4000, 50);
    let killed = false;
    for (const [i, body] of reqs.entries()) {
      await postUntilAccepted(body);
      if (i === 20) {
        compose("kill -s SIGKILL worker"); // no graceful shutdown, no offset commit
        killed = true;
      }
      if (i === 50) compose("start worker");
    }
    expect(killed).toBe(true);
    await settle(prefix, 4000);
    const { rows } = await db.query(
      `SELECT count(*) AS n, count(DISTINCT (gateway_id, device_id, metric, sequence)) AS distinct_n
         FROM readings WHERE device_id LIKE $1`,
      [`${prefix}%`],
    );
    expect(rows[0]).toEqual({ n: 4000, distinct_n: 4000 });
  });

  it("answers 503 while the broker is down, and the gateway's retries land once it is back", async () => {
    const prefix = uniq("broker");
    const reqs = batches(prefix, 600, 20);
    await postUntilAccepted(reqs[0]);

    compose("stop redpanda");
    try {
      const res = await post(reqs[1]);
      expect(res.status).toBe(503);
      // Gateways keep buffering and retrying in the background...
      const sending = (async () => {
        for (const body of reqs.slice(1)) await postUntilAccepted(body, 180_000);
      })();
      await sleep(3000);
      compose("start redpanda");
      await sending;
    } finally {
      compose("start redpanda");
    }
    await settle(prefix, 600);
    const { rows } = await db.query("SELECT count(*) AS n FROM readings WHERE device_id LIKE $1", [`${prefix}%`]);
    expect(rows[0].n).toBe(600);
  });
});
