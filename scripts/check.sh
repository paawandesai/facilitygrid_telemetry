#!/usr/bin/env sh
# Checks the three invariants directly in Postgres. Run after any scenario.
exec docker compose exec -T postgres psql -U telemetry -d telemetry -q -f - < "$(dirname "$0")/check.sql"
