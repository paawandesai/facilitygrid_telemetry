import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ago, duration, time } from "../format";
import { useNow } from "./useNow";

export function Gateways() {
  const now = useNow();
  const q = useQuery({ queryKey: ["gateways"], queryFn: api.gateways });
  const anomalies = useQuery({ queryKey: ["anomalies"], queryFn: api.anomalies });
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const staleAfter = stats.data?.stale_after_ms ?? 30000;
  const gws = q.data ?? [];
  return (
    <section>
      <h1>Gateways</h1>
      <p className="muted">
        A gateway is offline after {duration(staleAfter)} without a reading; its devices' values are then shown as stale.
        The watermark is the newest event time it has delivered.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Gateway</th>
            <th>Status</th>
            <th>Last heard</th>
            <th>Watermark (UTC)</th>
            <th className="num">Readings</th>
            <th className="num">Resends absorbed</th>
            <th className="num">Late</th>
          </tr>
        </thead>
        <tbody>
          {gws.map((g) => {
            const silent = now - Date.parse(g.last_seen_at);
            const online = silent <= staleAfter;
            return (
              <tr key={g.gateway_id}>
                <td>
                  <code>{g.gateway_id}</code>
                </td>
                <td>{online ? <span className="badge ok">online</span> : <span className="badge stale">offline {duration(silent)}</span>}</td>
                <td className="muted">{ago(g.last_seen_at, now)}</td>
                <td>{time(g.max_event_time)}</td>
                <td className="num">{g.readings_total}</td>
                <td className="num">{g.duplicates_total}</td>
                <td className="num">{g.late_total}</td>
              </tr>
            );
          })}
          {gws.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No gateway has reported yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Anomalies</h2>
      <p className="muted">Conflicting resends (same sequence, different content: the first is kept) and messages that could not be written.</p>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Kind</th>
            <th>Gateway</th>
            <th>Device</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {(anomalies.data ?? []).map((a) => (
            <tr key={a.id}>
              <td className="muted">{ago(a.created_at, now)}</td>
              <td>
                <span className="badge warn">{a.kind}</span>
              </td>
              <td>{a.gateway_id ?? "—"}</td>
              <td>{a.device_id ?? "—"}</td>
              <td>
                <code className="small detail">{JSON.stringify(a.detail)}</code>
              </td>
            </tr>
          ))}
          {anomalies.data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                None.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
