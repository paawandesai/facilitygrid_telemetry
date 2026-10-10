import type { MetricState } from "@fg/shared";
import type { SeriesPoint } from "../api";
import { ago, value } from "../format";
import { Sparkline } from "./Chart";

export function MetricTable({
  metrics,
  now,
  sparks,
}: {
  metrics: MetricState[];
  now: number;
  /** Optional recent trend per metric, drawn as a sparkline. */
  sparks?: Map<string, SeriesPoint[]>;
}) {
  if (metrics.length === 0) return <p className="muted small">No readings yet.</p>;
  return (
    <table className="metrics">
      <tbody>
        {metrics.map((m) => (
          <tr key={m.metric} className={m.stale ? "is-stale" : ""}>
            <td className="metric-name">{m.metric}</td>
            {/* Keyed on the reading so a new value replays the highlight. */}
            <td key={`${m.event_time}/${m.gateway_id}/${m.sequence}`} className="metric-value flash">
              {value(m.value)}
            </td>
            {sparks && <td className="spark-cell">{sparks.get(m.metric) && <Sparkline series={sparks.get(m.metric)!} />}</td>}
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
