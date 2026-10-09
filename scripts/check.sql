-- Invariant check you can run after any scenario (scripts/check.sh).
-- Every "violations" number must be 0.
\pset footer off
\echo '--- totals'
SELECT (SELECT count(*) FROM devices) AS devices,
       (SELECT count(*) FROM readings) AS readings,
       (SELECT coalesce(sum(resend_count), 0) FROM readings) AS duplicates_absorbed,
       (SELECT count(*) FROM readings WHERE late) AS late,
       (SELECT count(*) FROM anomalies) AS anomalies;

\echo '--- 1. no reading stored twice (same gateway, device, metric, sequence)'
SELECT count(*) - count(DISTINCT (gateway_id, device_id, metric, sequence)) AS violations FROM readings;

\echo '--- 2. current state = newest reading in history by (event_time, gateway_id, sequence)'
SELECT count(*) AS violations
  FROM (SELECT DISTINCT device_id, metric FROM readings) k
  LEFT JOIN device_metric_state s USING (device_id, metric)
  JOIN LATERAL (
    SELECT gateway_id, sequence FROM readings r
     WHERE r.device_id = k.device_id AND r.metric = k.metric
     ORDER BY event_time DESC, gateway_id DESC, sequence DESC LIMIT 1
  ) newest ON true
 WHERE s.device_id IS NULL OR (newest.gateway_id, newest.sequence) <> (s.gateway_id, s.sequence);

\echo '--- 3. every reporting device registered exactly once'
SELECT (SELECT count(DISTINCT device_id) FROM readings) - (SELECT count(*) FROM devices) AS violations;
