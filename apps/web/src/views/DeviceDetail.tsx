import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ago, time, value } from "../format";
import { MetricTable } from "./MetricTable";
import { DeviceTrends } from "./DeviceTrends";
import { useNow } from "./useNow";

export function DeviceDetail({ id }: { id: string }) {
  const now = useNow();
  const device = useQuery({ queryKey: ["device", id], queryFn: () => api.device(id) });
  const readings = useQuery({ queryKey: ["readings", id], queryFn: () => api.readings(id) });
  if (device.isLoading) return <p className="muted">Loading…</p>;
  if (device.error || !device.data) return <p className="error">Device not found.</p>;
  const d = device.data;
  const rows = readings.data ?? [];
  return (
    <section>
      <a href={d.status === "claimed" ? "#/" : "#/inbox"} className="back">
        ← {d.status === "claimed" ? "Equipment" : "Unregistered"}
      </a>
      <h1>
        {d.name ?? <code>{d.device_id}</code>}{" "}
        {d.status === "unclaimed" && <span className="badge warn">unregistered</span>}
      </h1>
      <p className="muted">
        <code>{d.device_id}</code> · {[d.equipment_type, d.location].filter(Boolean).join(" · ")}
        {d.claimed_at && <> · claimed {ago(d.claimed_at, now)}</>} · first seen {ago(d.first_seen_at, now)} via{" "}
        {d.first_seen_gateway_id}
      </p>

      <h2>Current state</h2>
      <MetricTable metrics={d.metrics} now={now} />

      <DeviceTrends id={d.device_id} now={now} />

      <h2>History</h2>
      <p className="muted">
        Every distinct reading, newest event time first. <span className="badge late">late</span> means it arrived after
        an equal-or-newer reading was already current, so it is kept in history but did not change the current value.{" "}
        <span className="badge resend">resent ×N</span> counts duplicates that were absorbed.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Event time (UTC)</th>
            <th>Metric</th>
            <th className="num">Value</th>
            <th>Gateway</th>
            <th className="num">Seq</th>
            <th>Arrived (UTC)</th>
            <th>Lane</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.late ? "is-late" : ""}>
              <td>{time(r.event_time)}</td>
              <td>{r.metric}</td>
              <td className="num">{value(r.value)}</td>
              <td>{r.gateway_id}</td>
              <td className="num">{r.sequence}</td>
              <td className="muted">{time(r.ingested_at)}</td>
              <td className="muted">{r.lane}</td>
              <td>
                {r.late && <span className="badge late">late</span>}{" "}
                {r.resend_count > 0 && <span className="badge resend">resent ×{r.resend_count}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
