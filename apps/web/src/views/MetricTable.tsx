import type { MetricState } from "@fg/shared";
import { ago, value } from "../format";

export function MetricTable({ metrics, now }: { metrics: MetricState[]; now: number }) {
  if (metrics.length === 0) return <p className="muted small">No readings yet.</p>;
  return (
    <table className="metrics">
      <tbody>
        {metrics.map((m) => (
          <tr key={m.metric} className={m.stale ? "is-stale" : ""}>
            <td className="metric-name">{m.metric}</td>
            <td className="metric-value">{value(m.value)}</td>
            <td className="muted small" title={`event_time ${m.event_time}, seq ${m.sequence}`}>
              taken {ago(m.event_time, now)}
            </td>
            <td className="muted small">{m.gateway_id}</td>
            <td>
              {m.stale ? (
                <span className="badge stale" title="The gateway that supplied this value has gone silent; it may be out of date">
                  stale
                </span>
              ) : (
                <span className="badge ok">live</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
