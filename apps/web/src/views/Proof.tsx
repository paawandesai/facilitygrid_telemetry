import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ago } from "../format";
import { useNow } from "./useNow";

/**
 * The three invariants, made visible: what each one has absorbed so far, and
 * the same violation checks as scripts/check.sql, re-run every few seconds.
 */
export function Proof() {
  const now = useNow();
  const q = useQuery({ queryKey: ["proof"], queryFn: api.proof });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error || !q.data) return <p className="error">Could not load: {String(q.error)}</p>;
  const p = q.data;
  const checks = [
    {
      label: "No reading stored twice",
      detail: "rows sharing (gateway, device, metric, sequence)",
      n: p.checks.duplicate_rows,
    },
    {
      label: "Current state is the newest reading by event time",
      detail: "current values that are not the newest reading in history",
      n: p.checks.state_not_newest,
    },
    {
      label: "Every reporting device registered exactly once",
      detail: "difference between devices seen in readings and device records",
      n: p.checks.registration_mismatch,
    },
  ];
  return (
    <section>
      <h1>Proof</h1>
      <p className="muted">
        What the system has absorbed so far, and the invariant checks run against the live database. Checked{" "}
        {ago(p.checked_at, now)}.
      </p>

      <div className="proof-grid">
        <div className="proof-tile">
          <div className="proof-value">{p.duplicates_dropped.toLocaleString()}</div>
          <div className="proof-label">Duplicate readings dropped</div>
          <p className="muted small">
            Resends and broker redeliveries that hit the unique key on (gateway, device, metric, sequence), across{" "}
            {p.readings_resent.toLocaleString()} distinct readings. {p.readings_stored.toLocaleString()} readings are
            stored once each.
            {p.conflicting_resends > 0 && <> {p.conflicting_resends} resends had different content; the first copy was kept and an anomaly logged.</>}
          </p>
        </div>
        <div className="proof-tile">
          <div className="proof-value">{p.late_ignored.toLocaleString()}</div>
          <div className="proof-label">Stale readings kept out of current state</div>
          <p className="muted small">
            Arrived after a newer reading for the same metric, so they went into history but never overwrote the current
            value. {p.late_backlog.toLocaleString()} of them came through the backlog lane (event time over 60 s old;{" "}
            {p.backlog_total.toLocaleString()} backlog readings in all).
          </p>
        </div>
        <div className="proof-tile">
          <div className="proof-value">{p.race_registrations_deduped.toLocaleString()}</div>
          <div className="proof-label">Racing registrations deduplicated</div>
          <p className="muted small">
            A second gateway reported a brand-new device within 5 s of the first. The device primary key let one insert
            win; there are {p.devices.toLocaleString()} device records and no doubles.
          </p>
        </div>
      </div>

      <h2>Invariant checks</h2>
      <table className="table">
        <tbody>
          {checks.map((c) => (
            <tr key={c.label}>
              <td>
                {c.n === 0 ? <span className="badge ok">✓ holds</span> : <span className="badge warn">✗ {c.n} violations</span>}
              </td>
              <td>
                <b>{c.label}</b>
                <div className="muted small">{c.detail}: {c.n}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Make it happen</h2>
      <p className="muted">Run the provided generator and watch the counters move:</p>
      <pre className="code">{`python3 telemetry_generator.py --target ${location.origin} --scenario replay   # duplicates + stale backlog
python3 telemetry_generator.py --target ${location.origin} --scenario race     # two gateways, one new device`}</pre>
    </section>
  );
}
