# Trace for seed `m-paawandesai` (not the submission seed)

The submission seed is `paawandesai` (see DESIGN.md). This is the same exercise for `m-paawandesai`, kept for reference.

```
your personalized trace scenario (seed=m-paawandesai), device=trace-device-7278:
 #  gateway        metric          value   event_time offset (s)
 0  gw-a-m-paawandesai temperature     55.88                       3
 1  gw-b-m-paawandesai temperature      62.9                       0
 2  gw-b-m-paawandesai power_draw      91.14                       1
 3  gw-a-m-paawandesai temperature     34.94                       4
 4  gw-a-m-paawandesai power_draw      14.06                       2
 5  gw-a-m-paawandesai temperature     91.34                       5
 1  gw-b-m-paawandesai temperature      62.9                       0
```


device `trace-device-7278`, gateways A = `gw-a-m-paawandesai` and B = `gw-b-m-paawandesai`, sent one request each in this order, `sequence` = #. *t* is the run's base time; all readings are within seconds of now, so all take the live lane.

**Prediction, written before running it:**

| # | Reading | Stored? | Current after it | Late? |
|---|---|---|---|---|
| 0 | A temperature 55.88 @ t+3 | yes; **registers the device** (first seen via A, one `device_discovered`) | temperature 55.88 | no |
| 1 | B temperature 62.9 @ t+0 | yes | temperature stays 55.88 (t+0 < t+3) | **yes**: #0, newer, arrived first |
| 2 | B power_draw 91.14 @ t+1 | yes | power_draw 91.14 | no |
| 3 | A temperature 34.94 @ t+4 | yes | temperature 34.94 | no |
| 4 | A power_draw 14.06 @ t+2 | yes | power_draw 14.06 | no |
| 5 | A temperature 91.34 @ t+5 | yes | temperature 91.34 | no |
| 6 | resend of #1, byte-identical | **no**; #1's `resend_count` becomes 1, no anomaly | unchanged | #1 stays late |

End state: **6 readings**, 1 unclaimed device, current **temperature = 91.34** (A, seq 5) and **power_draw = 14.06** (A, seq 4), **only #1 late**. Gateway A has 4 readings, B has 2 plus 1 absorbed resend. About 30 s later both values show *stale* (the gateways stopped reporting), which is expected.

**Real run** (fresh stack, `docker compose run --rm generator --scenario trace --seed m-paawandesai --yes`): **matched on every point**: 6 rows, only #1 late with `resend_count` 1, the same two current values, one device first seen via A, no anomalies. Nothing needed fixing.

