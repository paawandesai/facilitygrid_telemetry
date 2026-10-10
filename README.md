# FacilityGrid Telemetry

Ingests equipment telemetry from site gateways through a real broker, keeps every device's current state correct whatever order data arrives in, and shows it live in a small web app where unregistered devices can be claimed.

TypeScript throughout: **Fastify + Zod** API, **KafkaJS** worker, **Redpanda** (Kafka API) broker, **Postgres 16** with plain SQL, **React + Vite** web app. Why it's built this way: [DESIGN.md](DESIGN.md). What's left out: [CUTS.md](CUTS.md). How AI was used: [AI_USAGE.md](AI_USAGE.md).

## Run it

Requires Docker with Compose v2 (`docker-compose` or `docker compose`; the classic builder works, BuildKit isn't required). From a clean checkout:

```sh
docker-compose up
```

The first run builds the images and takes a few minutes. When `api` reports healthy, everything is on **one host port**:

| What | Where |
|---|---|
| Web app (equipment board, unregistered inbox, gateways) | http://localhost:8080 |
| Ingest endpoint | `POST http://localhost:8080/ingest/readings` (nginx hands it to the API) |

If 8080 is taken, pick another: `WEB_PORT=9080 docker-compose up`, or put `WEB_PORT=9080` in `.env` (see `.env.example`). The API, Postgres and Redpanda are not published on the host, so they can't clash with anything running locally. After changing code, `docker-compose up --build`. To start again from empty: `docker-compose down -v`.

### Dev overlay (tests, psql, Redpanda Console)

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

| What | Default host port | Override |
|---|---|---|
| API (direct) | 13000 | `API_PORT` |
| Postgres (user/password/db `telemetry`) | 15432 | `POSTGRES_PORT` |
| Redpanda (Kafka API) | 19092 | `REDPANDA_PORT` |
| Redpanda Console (topics, consumer lag) | 18088 | `CONSOLE_PORT` |

## Send readings

```sh
curl -X POST localhost:8080/ingest/readings -H 'content-type: application/json' -d '{
  "gateway_id": "gw-1", "device_id": "ahu-1", "metric": "supply_temp",
  "value": 13.2, "event_time": "2026-10-09T14:00:00Z", "sequence": 1 }'
```

- `202` means the reading is durably on the broker. `400` means a malformed body, with per-field errors; nothing in that request is stored. `422` means `event_time` is more than 5 minutes in the future. `503` means the broker is unavailable: retry, because nothing was accepted.
- The body may also be an array of readings (all-or-nothing). `event_time` may be ISO-8601 or epoch seconds/milliseconds; `value` may be a number, string or boolean.

## Run the generator and the seeded trace

`telemetry_generator.py` (repo root) is the provided simulator (Python 3, standard library only). `--target` is the base URL; the script appends `/ingest/readings`. The compose `generator` service runs it on the compose network, already pointed at the API:

```sh
docker-compose run --rm generator --scenario clean
docker-compose run --rm generator --scenario replay
docker-compose run --rm generator --scenario race
docker-compose run --rm generator --scenario trace --seed paawandesai   # prints the sequence, Enter sends it
```

Or from the host, with Python 3, exactly as the brief writes it:

```sh
python3 telemetry_generator.py --target http://localhost:8080 --scenario clean
python3 telemetry_generator.py --target http://localhost:8080 --scenario trace --seed paawandesai
```

Use your `WEB_PORT` if you changed it. Add `--yes` to send the trace without the prompt.

The hand trace for seed `paawandesai` is in [DESIGN.md](DESIGN.md#trace---scenario-trace---seed-paawandesai), and the printed sequences are in `docs/`.

After any scenario, check the three invariants directly in Postgres:

```sh
./scripts/check.sh      # every "violations" line must be 0
```

## Tests

The invariant tests run against the live stack started with the dev overlay (above), because they read Postgres directly. They need Node 20+ on the host and honour the same `API_PORT` / `POSTGRES_PORT` variables.

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
telemetry_generator.py   the provided gateway simulator
```

API used by the web app: `GET /devices?status=claimed|unclaimed`, `GET /devices/:id`, `GET /devices/:id/readings`, `POST /devices/:id/claim`, `GET /gateways`, `GET /anomalies`, `GET /stats`, `GET /events` (SSE), `GET /healthz`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PORT` | `8080` | The only host port `docker-compose up` publishes. |
| `API_PORT`, `POSTGRES_PORT`, `REDPANDA_PORT`, `CONSOLE_PORT` | `13000`, `15432`, `19092`, `18088` | Host ports for the dev overlay only. |
| `STALE_AFTER_MS` | `30000` | Silence after which a gateway is offline and its values are shown as stale. |

Set any of them in the shell or in `.env` (copy `.env.example`).

The backlog-lane threshold (60 s) and future-skew limit (5 min) are constants in `packages/shared/src/index.ts`.

## Troubleshooting

- **`Bind for …:8080 failed: port is already allocated`**: set `WEB_PORT` (above). The same goes for the dev overlay's ports.
- **Builds behind a TLS-intercepting proxy** (corporate networks): `scripts/build-behind-proxy.sh` builds the images with the proxy's CA, then `docker compose up --no-build`.
