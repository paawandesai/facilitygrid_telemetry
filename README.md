# FacilityGrid Telemetry

Work in progress. Full README comes with the final build.

```sh
docker compose up --build
```

- Ingest: `POST http://localhost:3000/ingest/readings`
- API: `GET http://localhost:3000/devices`, `/gateways`, `/stats`, `/anomalies`
- Redpanda Console: http://localhost:8088
- Postgres: `localhost:5433` (telemetry/telemetry)
