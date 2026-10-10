# Design

## The problem as I understood it

Gateways deliver readings **at least once and in any order**: live data, hour-old backlogs, resends, and first sightings of unknown devices, sometimes from two gateways at once. So the one idea the design hangs on: **correctness never depends on arrival order.** Every write is an idempotent, order-independent merge enforced by a Postgres constraint. The broker only has to deliver at least once (durability, back-pressure, replay); the database supplies correctness.

```
gateway ─POST─▶ api (Fastify) ─acks=all─▶ Redpanda ─▶ worker (2 consumer groups) ─1 txn/batch─▶ Postgres ─NOTIFY─▶ api ─SSE─▶ web
                 202 only after the broker has it      readings.live / readings.backlog / readings.dlq
```

| Invariant | Mechanism (all in `apps/worker/src/process.ts`) |
|---|---|
| 1. No duplicate or lost reading | `UNIQUE (gateway_id, device_id, metric, sequence)` + `ON CONFLICT DO NOTHING`. The API returns `202` only after the broker acks (`acks=all`), `503` otherwise, so the gateway keeps it. The worker commits offsets only **after** the DB transaction commits, so a crash means redelivery, which the unique key absorbs. |
| 2. Current state = newest by event time | A last-writer-wins register per (device, metric): `INSERT … ON CONFLICT DO UPDATE … WHERE (event_time, gateway_id, sequence) > current`. An older reading can never overwrite a newer one, whatever the interleaving; ties break deterministically. |
| 3. Registered exactly once | `devices.device_id` primary key + `ON CONFLICT DO NOTHING RETURNING`. Under a race the loser blocks on the key, then does nothing; only the winner gets a row back, so `device_discovered` fires once. Claiming is a compare-and-set (`WHERE status = 'unclaimed'`), so two claimers can't both win (`409`). |

A resend with the same identity but **different content** keeps the first copy and records a `conflicting_resend` anomaly instead of silently choosing.

## The late-data decision

**What I chose: never wait; label the uncertainty.** The current value updates the moment a reading is written. That is safe *because* of invariant 2: a late reading can't regress state, so holding data back would buy no correctness, only latency. Instead the system is honest about what it doesn't know:

- **`late` flag.** A reading is *late* if, when it arrived at the API, a reading with a newer event time for the same device and metric had **already arrived**. It is stored in history but never shown as current. It is defined by arrival order at the edge (a microsecond, monotonic `received_at`), not by which worker lane got there first, so it is reproducible: the property test checks it against an oracle. (In the generator's `clean` scenario three gateways report the same devices over the same two seconds, so about half its readings are, correctly, flagged late.)
- **Staleness, per gateway.** Each gateway has a watermark (`max_event_time`) and a `last_seen_at`. After **30 s** of silence (`STALE_AFTER_MS`) every value that gateway supplied is badged *stale* and the gateway shows *offline since …*. The board stays live for everything that is live.
- **Backlog lane.** Readings more than 60 s old go to `readings.backlog`, consumed by a separate consumer group, so an hour-long replay never sits in front of other gateways' live data.

**Considered and rejected**

| Option | Why not |
|---|---|
| Last arrival wins | Violates invariant 2: a replayed backlog overwrites newer data. |
| Buffer and reorder with a fixed delay L | Adds L of latency to every value on the board, and still needs a rule for data later than L. The LWW merge already gives the reordering for free. |
| Global low watermark (Flink-style) | One offline gateway freezes the watermark for the whole building; with an idle timeout it degrades to the fixed delay. Right for finalising aggregates, wrong for a live board. |
| Drop readings older than a threshold | Violates invariant 1. |

A real watermark *does* matter for anything **finalised**, such as hourly rollups or "did this AHU hold setpoint during the test window". The design for that is cut (see CUTS.md): a window closes when every reporting gateway's watermark is past its end, or after a 15-minute max wait. A later reading re-opens it and marks the result *revised*, because commissioning evidence that silently changes is worse than evidence marked as revised.

**If a gateway is offline for an hour instead of a minute**, what breaks first:
1. **Its devices show stale for an hour.** Nothing displayed is wrong, but nothing is current. Anything evaluated in that hour (alarms, functional tests) ran on stale data; we flag it but don't re-evaluate (cut).
2. **The reconnect burst.** An hour of readings lands at once. The backlog lane keeps it from delaying live data; its cost shows up as backlog consumer lag (visible in Redpanda Console), not as a stale board.
3. **The gateway's own buffer** can overflow; we can't recover what it never sends. Sequence gaps would make that visible (not built yet).
4. Dedupe is unaffected: the unique key has no time horizon (at 10× it needs one, below).

## Trace: `--scenario trace --seed paawandesai`

The seed is my GitLab username, `paawandesai`. Printed sequence (`docs/trace-paawandesai.txt`): device `trace-device-1338`, gateways A = `gw-a-paawandesai` and B = `gw-b-paawandesai`, one request each in this order, `sequence` = #. *t* is the run's base time; every reading is within seconds of now, so all take the live lane.

**Prediction, written before running it:**

| # | Reading | Stored? | Current after it | Late? |
|---|---|---|---|---|
| 0 | B temperature 77.38 @ t+1 | yes; **registers the device** (first seen via B, one `device_discovered`) | temperature 77.38 | no |
| 1 | B power_draw 58.41 @ t+4 | yes | power_draw 58.41 | no |
| 2 | A power_draw 27.92 @ t+0 | yes | power_draw stays 58.41 | **yes**: #1, newer, arrived first |
| 3 | A temperature 66.78 @ t+3 | yes | temperature 66.78 | no |
| 4 | B vibration 7.28 @ t+5 | yes | vibration 7.28 | no |
| 5 | A vibration 63.2 @ t+2 | yes | vibration stays 7.28 | **yes**: #4, newer, arrived first |
| 6 | resend of #2, byte-identical | **no**; #2's `resend_count` becomes 1, no anomaly | unchanged | #2 stays late |

End state: **6 readings**, 1 unclaimed device, current **temperature = 66.78** (A, seq 3), **power_draw = 58.41** (B, seq 1) and **vibration = 7.28** (B, seq 4), with **#2 and #5 late**. Gateway A has 3 readings plus 1 absorbed resend, and B has 3. About 30 s later all three values show *stale* (the gateways stopped reporting), which is expected.

**Real run** (fresh stack, `docker compose run --rm generator --scenario trace --seed paawandesai --yes`): **matched on every point**. There were 6 rows, #2 and #5 were late, and #2 had `resend_count` 1. The three current values were as predicted, the one device was first seen via B, gateway counts were A 3 (+1 resend) and B 3, and there were no anomalies. Nothing needed fixing.

## What changes at 10× gateways

- **Throughput.** Roughly 1k readings/s per building today (12 gateways × 20 devices × 4 metrics at 1 Hz), so about 10k/s. Row-at-a-time upserts won't keep up: switch to set-based writes per batch (`unnest`), more partitions and more worker replicas. That's safe because the merge is commutative; the concurrency test already races overlapping batches.
- **History growth.** Partition `readings` by month (or TimescaleDB), and give dedupe a horizon (for example 7 days of unique index). Older resends fall back to a slower check. The `late` lookup gets the same bound.
- **Reconnect storms.** A site-wide outage means 120 gateways replay at once. The backlog lane, API rate limiting (`429` + `Retry-After`; gateways already buffer) and more backlog consumers keep live traffic live.
- **Hot rows.** Gateway liveness is already aggregated once per batch. At 10× it moves to an in-memory heartbeat.
- **Fan-out.** Coalesce SSE per device (about 250 ms) and scope subscriptions per building or project.
- **Multi-tenant.** Add `project_id` to every key and partition by it; FacilityGrid's unit of work is the commissioning project.
