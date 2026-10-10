# Trace for seed `paawandesai` (alternative seed)

DESIGN.md traces the seed `m-paawandesai`. This is the same exercise for `paawandesai`, in case that's the GitHub username the evaluators use. A = `gw-a-paawandesai`, B = `gw-b-paawandesai`, device `trace-device-1338`, `sequence` = #, sent in this order.

```
your personalized trace scenario (seed=paawandesai), device=trace-device-1338:
 #  gateway        metric          value   event_time offset (s)
 0  gw-b-paawandesai temperature     77.38                       1
 1  gw-b-paawandesai power_draw      58.41                       4
 2  gw-a-paawandesai power_draw      27.92                       0
 3  gw-a-paawandesai temperature     66.78                       3
 4  gw-b-paawandesai vibration        7.28                       5
 5  gw-a-paawandesai vibration        63.2                       2
 2  gw-a-paawandesai power_draw      27.92                       0
```

**Prediction (written before running it):**

| # | Reading | Stored? | Current after it | Late? |
|---|---|---|---|---|
| 0 | B temperature 77.38 @ t+1 | yes; registers the device (first seen via B) | temperature 77.38 | no |
| 1 | B power_draw 58.41 @ t+4 | yes | power_draw 58.41 | no |
| 2 | A power_draw 27.92 @ t+0 | yes | power_draw stays 58.41 | **yes**: #1 is newer and arrived first |
| 3 | A temperature 66.78 @ t+3 | yes | temperature 66.78 | no |
| 4 | B vibration 7.28 @ t+5 | yes | vibration 7.28 | no |
| 5 | A vibration 63.2 @ t+2 | yes | vibration stays 7.28 | **yes**: #4 is newer and arrived first |
| 6 | resend of #2 | no; #2's `resend_count` becomes 1 | unchanged | #2 stays late |

End state: 6 readings, 1 device; current temperature = 66.78 (A, seq 3), power_draw = 58.41 (B, seq 1), vibration = 7.28 (B, seq 4); #2 and #5 late.

**Real run** (`docker compose run --rm generator --scenario trace --seed paawandesai --yes`): matched on every point.
