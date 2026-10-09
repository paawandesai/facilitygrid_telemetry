-- FacilityGrid telemetry schema.
-- Each of the three invariants is a database constraint, so it holds no matter
-- how many workers run or in what order the broker delivers messages.
--
-- Identifiers use COLLATE "C" so the (event_time, gateway_id, sequence)
-- tie-break is byte order everywhere (Postgres, the JS test oracle, replays).

-- Invariant 3: a device is registered exactly once (primary key + ON CONFLICT DO NOTHING).
CREATE TABLE devices (
  device_id             text COLLATE "C" PRIMARY KEY,
  status                text NOT NULL DEFAULT 'unclaimed' CHECK (status IN ('unclaimed', 'claimed')),
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  first_seen_gateway_id text COLLATE "C" NOT NULL,
  name                  text,
  equipment_type        text,
  location              text,
  claimed_at            timestamptz,
  claimed_by            text
);

-- Invariant 1: history, one row per reading identity.
CREATE TABLE readings (
  id           bigserial PRIMARY KEY,
  gateway_id   text COLLATE "C" NOT NULL,
  device_id    text COLLATE "C" NOT NULL REFERENCES devices,
  metric       text COLLATE "C" NOT NULL,
  value        jsonb NOT NULL,
  event_time   timestamptz NOT NULL,
  sequence     bigint NOT NULL,
  received_at  timestamptz NOT NULL,         -- when the API accepted it (first arrival)
  arrival_idx  int NOT NULL DEFAULT 0,       -- position within that request, orders a batch
  ingested_at  timestamptz NOT NULL DEFAULT now(), -- when the worker wrote it
  lane         text NOT NULL DEFAULT 'live',
  resend_count int NOT NULL DEFAULT 0,       -- duplicates absorbed by the unique key
  -- Arrived after a reading with a newer event time (same device and metric)
  -- had already arrived. Kept in history; never the current value.
  late         boolean NOT NULL DEFAULT false,
  CONSTRAINT readings_identity UNIQUE (gateway_id, device_id, metric, sequence)
);
CREATE INDEX readings_device_metric_time ON readings (device_id, metric, event_time DESC);

-- Invariant 2: current state, a last-writer-wins register per (device, metric)
-- ordered by (event_time, gateway_id, sequence). Only moves forward.
CREATE TABLE device_metric_state (
  device_id  text COLLATE "C" NOT NULL REFERENCES devices,
  metric     text COLLATE "C" NOT NULL,
  value      jsonb NOT NULL,
  event_time timestamptz NOT NULL,
  gateway_id text COLLATE "C" NOT NULL,
  sequence   bigint NOT NULL,
  reading_id bigint NOT NULL REFERENCES readings,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, metric)
);

-- Per-gateway liveness and event-time watermark.
CREATE TABLE gateways (
  gateway_id       text COLLATE "C" PRIMARY KEY,
  last_seen_at     timestamptz NOT NULL,  -- arrival time of the newest processed reading
  max_event_time   timestamptz NOT NULL,  -- event-time watermark
  max_sequence     bigint NOT NULL,
  readings_total   bigint NOT NULL DEFAULT 0,
  duplicates_total bigint NOT NULL DEFAULT 0
);

-- Things worth a human's attention: conflicting resends, poison messages.
CREATE TABLE anomalies (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  gateway_id text,
  device_id  text,
  detail     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX anomalies_created ON anomalies (created_at DESC);
