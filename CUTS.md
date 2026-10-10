# Cuts

What I deliberately left out, and why. The three invariants and the late-data story are complete and tested; everything below is breadth I chose not to buy in three days.

| Cut | Why it's safe to cut now | What it would take |
|---|---|---|
| **Auth and multi-tenancy** | Not what the exercise tests; it would be boilerplate. Claims record a free-text `claimed_by`. | Gateway API keys on ingest, user auth on the web app, `project_id` on every key. |
| **Windowed rollups / finalised aggregates** | The live board doesn't need them, and the Analysis page computes its stats on read from history, which is fast enough at demo volume. The design (close a window on all gateways' watermarks or a 15-minute max wait, re-open and mark *revised* on later data) is in DESIGN.md. | A rollup table plus a small scheduler that reads `gateways.max_event_time`. |
| **Re-evaluating alarms or tests after late data** | We flag stale and late data. Nothing here evaluates alarms yet. | A trigger on late inserts that re-queues affected windows. |
| **Sequence-gap detection** | The generator numbers readings per (gateway, device) and restarts at 0 per device, so gaps can only be judged per (gateway, device). Nothing in the brief asks for it, and dedupe doesn't depend on it. | A `sequence_gap` anomaly when a (gateway, device) counter skips. |
| **Dedupe horizon and table partitioning** | Unbounded unique index is fine at this volume. | Monthly partitions plus a bounded unique window; see DESIGN.md "10×". |
| **Set-based batch writes** | Row-at-a-time inside one transaction per batch is simpler to read and to defend, and fast enough here. | `unnest()`-based multi-row upserts. |
| **Kafka exactly-once transactions / idempotent producer** | They can't cover the Postgres write, so they add complexity without adding a guarantee. The unique key already makes redelivery and producer retries harmless (tested). | n/a, by design. |
| **Schema registry / Avro** | JSON on the wire matches the required contract; one schema, validated with Zod at the edge. | Registry plus versioned schemas once there are multiple producers. |
| **Unit normalisation, metric catalogue** | Values are stored as sent (`jsonb`: numbers and status strings both fit). | A metric registry with units and ranges. |
| **Production deploy (Kubernetes, TLS, backups, metrics)** | `docker compose up` is the brief. [DEPLOY.md](DEPLOY.md) puts the same compose stack on one free VM for a demo link; that is not a production setup. | Helm chart, managed Postgres, Prometheus metrics on lag and anomaly rates. |
| **A dead-letter UI** | Poison messages go to `readings.dlq` and appear as anomalies in the UI, so they are visible, not lost. No replay button. | A "replay from DLQ" admin action. |
| **Smarter anomaly detection** | Outliers are a plain 3σ test against the window mean, which catches spikes but not slow drift against a seasonal baseline. | Per-metric baselines by hour of day, or rate-of-change rules configured per equipment type. |
| **Browser end-to-end tests** | The invariants are tested through the real HTTP endpoint and Postgres; the UI is thin over the REST API. | Playwright smoke test of board, claim and live update. |
