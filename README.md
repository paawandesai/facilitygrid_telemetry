# FacilityGrid Telemetry

Ingests equipment telemetry from site gateways through a real broker, keeps every device's current state correct whatever order data arrives in, and shows it live in a small web app where unregistered devices can be claimed.

TypeScript throughout: **Fastify + Zod** API, **KafkaJS** worker, **Redpanda** (Kafka API) broker, **Postgres 16** with plain SQL, **React + Vite** web app. Why it's built this way: [DESIGN.md](DESIGN.md). What's left out: [CUTS.md](CUTS.md). How AI was used: [AI_USAGE.md](AI_USAGE.md).

## Run it

Requires Docker with Compose v2. From a clean checkout:

```sh
docker compose up --build
```

The first build takes a few minutes. When `api` reports healthy:

| What | Where |
|---|---|
| Web app (equipment board, unregistered inbox, gateways) | http://localhost:8080 |
| Ingest endpoint | `POST http://localhost:3000/ingest/readings` (also accepted at `:8080`) |
| Redpanda Console (topics, consumer lag) | http://localhost:8088 |
| Postgres | `localhost:5433`, user/password/db `telemetry` |

To start again from empty: `docker compose down -v`.

## Send readings

```sh
curl -X POST localhost:3000/ingest/readings -H 'content-type: application/json' -d '{
  "gateway_id": "gw-1", "device_id": "ahu-1", "metric": "supply_temp",
  "value": 13.2, "event_time": "2026-10-09T14:00:00Z", "sequence": 1 }'
```

- `202` means the reading is durably on the broker. `400` means a malformed body, with per-field errors; nothing in that request is stored. `422` means `event_time` is more than 5 minutes in the future. `503` means the broker is unavailable: retry, because nothing was accepted.
- The body may also be an array of readings (all-or-nothing). `event_time` may be ISO-8601 or epoch seconds/milliseconds; `value` may be a number, string or boolean.

## Run the generator and the seeded trace

`tools/telemetry_generator.py` is the provided simulator (Python 3, standard library only). `--target` is the base URL; the script appends `/ingest/readings`. The compose `generator` service runs it on the compose network, already pointed at the API:

```sh
docker compose run --rm generator --scenario clean
docker compose run --rm generator --scenario replay
docker compose run --rm generator --scenario race
docker compose run --rm generator --scenario trace --seed m-paawandesai   # prints the sequence, Enter sends it
```

Or from the host, with Python 3: `python3 tools/telemetry_generator.py --target http://localhost:3000 --scenario trace --seed m-paawandesai`. The script's own example target, `http://localhost:8080`, works too, because the web app's nginx forwards `/ingest/readings` to the API. Add `--yes` to send the trace without the prompt.

The hand trace for seed `m-paawandesai` is in [DESIGN.md](DESIGN.md#trace---scenario-trace---seed-m-paawandesai), and the printed sequences are in `docs/`.

After any scenario, check the three invariants directly in Postgres:

```sh
./scripts/check.sh      # every "violations" line must be 0
```

## Tests

The invariant tests run against the live stack (`docker compose up` first). They need Node 20+ on the host.

```sh
npm ci
npm run test:unit          # wire-contract parsing and ordering
npm run test:invariants    # property, race, replay, redelivery tests through the real endpoint
npm run test:chaos         # kills the worker mid-stream and stops Redpanda (restarts both)
```

| Test | What it proves |
|---|---|
| `tests/invariants.property.test.ts` | Random readings, shuffled, duplicated 1–4×, split into random requests across the live and backlog lanes. Postgres must match an in-memory oracle for history, current state, registration, discovery events and every `late` flag. |
| `tests/race.test.ts` | 40 new devices, each reported at once by two gateways through different lanes (so two consumers race): each is registered and announced exactly once. 10 simultaneous claims produce exactly one winner. |
| `tests/replay.test.ts` | An hour-long backlog with resends: no duplicates, state never regresses, the backlog is flagged late. A conflicting resend keeps the first copy and logs an anomaly. Bad input is rejected whole. |
| `tests/redelivery.test.ts` | The worker's crash window (DB committed, offset not): processing a batch twice changes nothing. Overlapping batches written concurrently converge to the sequential result. |
| `tests/chaos.test.ts` | SIGKILL the worker mid-stream: nothing lost or duplicated. Stop Redpanda: the API answers `503`, the gateways' retries land after restart. |

`PROPERTY_RUNS=50 npm run test:invariants` runs a longer property search.

## Layout

```
apps/api          Fastify: POST /ingest/readings, REST for the web app, SSE (/events)
apps/worker       KafkaJS consumers (live + backlog lanes), one Postgres transaction per batch
apps/web          React + Vite, served by nginx (proxies /api to the API)
packages/shared   Zod wire contract, ordering and lane rules shared by all three
db/migrations     The schema; the invariants live here as constraints
tests/            Invariant tests against the running stack
scripts/          check.sh (SQL invariant check), build-behind-proxy.sh
tools/            telemetry_generator.py
```

API used by the web app: `GET /devices?status=claimed|unclaimed`, `GET /devices/:id`, `GET /devices/:id/readings`, `POST /devices/:id/claim`, `GET /gateways`, `GET /anomalies`, `GET /stats`, `GET /events` (SSE), `GET /healthz`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `STALE_AFTER_MS` | `30000` | Silence after which a gateway is offline and its values are shown as stale (`STALE_AFTER_MS=60000 docker compose up`). |

The backlog-lane threshold (60 s) and future-skew limit (5 min) are constants in `packages/shared/src/index.ts`.

## Troubleshooting

- **Port already in use**: change the left-hand side of the `ports:` entries in `docker-compose.yml`.
- **Builds behind a TLS-intercepting proxy** (corporate networks): `scripts/build-behind-proxy.sh` builds the images with the proxy's CA, then `docker compose up --no-build`.
