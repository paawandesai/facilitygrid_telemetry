# Design

## The problem as I understood it

Gateways deliver readings **at least once, in any order**: live data, hour-old backlogs, resends, and unknown devices, sometimes from two gateways at once. So **correctness never depends on arrival order**: every write is an idempotent, order-independent merge enforced by a Postgres constraint. The broker gives durability, back-pressure and replay; the database gives correctness.

```
gateway ─POST─▶ api (Fastify) ─acks=all─▶ Redpanda ─▶ worker (2 consumer groups) ─1 txn/batch─▶ Postgres ─NOTIFY─▶ api ─SSE─▶ web
                 202 only after the broker has it      readings.live / readings.backlog / readings.dlq
```

| Invariant | Mechanism (all in `apps/worker/src/process.ts`) |
|---|---|
| 1. No duplicate or lost reading | `UNIQUE (gateway_id, device_id, metric, sequence)` + `ON CONFLICT DO NOTHING`. `202` only after the broker acks (`acks=all`), else `503` and the gateway keeps it. Offsets are committed only after the DB transaction, so a crash means redelivery, which the key absorbs. |
| 2. Current state = newest by event time | Last-writer-wins per (device, metric): `ON CONFLICT DO UPDATE … WHERE (event_time, gateway_id, sequence) > current`. Older never overwrites newer, in any interleaving; ties break deterministically. |
| 3. Registered exactly once | `devices` primary key + `ON CONFLICT DO NOTHING RETURNING`: only the race winner gets a row back, so `device_discovered` fires once. Claiming is a compare-and-set (`409` for the loser). |

A resend with the same identity but different content keeps the first copy and logs a `conflicting_resend` anomaly.

## The late-data decision

**What I chose: never wait; label the uncertainty.** The current value updates the moment a reading is written. Invariant 2 already means a late reading can't regress state, so waiting would buy latency, not correctness. Instead the system shows what it doesn't know:

- **`late` flag.** A reading is *late* if, when it arrived at the API, a reading with a newer event time for the same device and metric had **already arrived**. It is kept in history but never shown as current. Arrival order at the edge (monotonic `received_at`), not worker lane order, makes it reproducible.
- **Staleness, per gateway.** Each gateway has a watermark (`max_event_time`) and `last_seen_at`. After **30 s** of silence (`STALE_AFTER_MS`) its values are badged *stale* and it shows *offline since …*; everything else stays live.
- **Backlog lane.** Readings over 60 s old go to `readings.backlog`, a separate consumer group, so a replay never queues ahead of live data.

**Considered and rejected**

| Option | Why not |
|---|---|
| Last arrival wins | Violates invariant 2. |
| Buffer and reorder with a fixed delay L | Adds L to every value on the board and still needs a rule for data later than L; the LWW merge reorders for free. |
| Global low watermark (Flink-style) | One offline gateway freezes it for the whole building. Right for finalising aggregates, wrong for a live board. |
| Drop readings older than a threshold | Violates invariant 1. |

A watermark *does* matter for **finalised** results (hourly rollups, test windows). That is cut (CUTS.md): a window would close when every gateway's watermark passes its end or after 15 minutes, and a later reading re-opens it marked *revised*.

**If a gateway is offline for an hour instead of a minute**, what breaks first:
1. **Its devices show stale for an hour.** Nothing shown is wrong, but nothing is current; anything judged in that hour used stale data (flagged, not re-evaluated).
2. **The reconnect burst.** An hour of readings lands at once. The backlog lane keeps it out of the live path; the cost is backlog consumer lag, not a stale board.
3. **The gateway's own buffer** can overflow, and we can't recover what it never sends (gap detection is cut).

## Trace: `--scenario trace --seed paawandesai`

The seed is my GitLab username, `paawandesai`. Printed sequence (`docs/trace-paawandesai.txt`): device `trace-device-1338`, A = `gw-a-paawandesai`, B = `gw-b-paawandesai`, one request each in order, `sequence` = #, *t* = base time (all live lane).

**Prediction, written before running it:**

| # | Reading | Stored? | Current after it | Late? |
|---|---|---|---|---|
| 0 | B temperature 77.38 @ t+1 | yes; **registers the device** (via B, once) | temperature 77.38 | no |
| 1 | B power_draw 58.41 @ t+4 | yes | power_draw 58.41 | no |
| 2 | A power_draw 27.92 @ t+0 | yes | stays 58.41 | **yes** (#1 newer, arrived first) |
| 3 | A temperature 66.78 @ t+3 | yes | temperature 66.78 | no |
| 4 | B vibration 7.28 @ t+5 | yes | vibration 7.28 | no |
| 5 | A vibration 63.2 @ t+2 | yes | stays 7.28 | **yes** (#4 newer, arrived first) |
| 6 | resend of #2, identical | **no**; #2 `resend_count` = 1 | unchanged | #2 stays late |

End state: **6 readings**, 1 unclaimed device, current **temperature 66.78** (A#3), **power_draw 58.41** (B#1), **vibration 7.28** (B#4), **#2 and #5 late**; all *stale* 30 s later. **Real run** on a fresh stack: **matched on every point**, no anomalies.

## What changes at 10× gateways

About 1k readings/s per building today (12 gateways × 20 devices × 4 metrics at 1 Hz) becomes 10k/s. **Writes:** set-based upserts per batch (`unnest`), more partitions and worker replicas. **History:** monthly partitions; dedupe and `late` lookups get a 7-day horizon. **Reconnect storms:** backlog lane, `429` + `Retry-After`. **Fan-out:** SSE coalesced and scoped per project.
