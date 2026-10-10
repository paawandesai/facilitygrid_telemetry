import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { value } from "../format";
import { LineChart } from "./Chart";
import { Trend, WindowPicker, useWindow } from "./Analysis";

/** Per-metric charts and window statistics for one device. */
export function DeviceTrends({ id, now }: { id: string; now: number }) {
  const [minutes, setMinutes] = useWindow(60);
  const q = useQuery({ queryKey: ["device-analysis", id, minutes], queryFn: () => api.deviceAnalysis(id, minutes) });
  const metrics = q.data?.metrics ?? [];
  const from = now - minutes * 60_000;
  return (
    <>
      <div className="section-head">
        <h2>Trends</h2>
        <WindowPicker minutes={minutes} onChange={setMinutes} />
      </div>
      <p className="muted small">
        Average per time bucket with its min–max range. <span className="key key-late" /> late reading (kept in history,
        never current) · <span className="key key-outlier" /> outlier (more than 3σ from the window mean). Gaps are
        periods with no readings.
      </p>
      {q.isLoading ? (
        <p className="muted">Loading…</p>
      ) : metrics.length === 0 ? (
        <div className="empty">No numeric readings in the last {minutes} minutes.</div>
      ) : (
        <div className="chart-grid">
          {metrics.map((m) => (
            <div key={m.metric} className="chart-card">
              <div className="chart-title">
                <b>{m.metric}</b>
                <span className="metric-value">{value(m.last)}</span>
              </div>
              <LineChart
                series={m.series}
                marks={(q.data?.points ?? []).filter((p) => p.metric === m.metric)}
                from={from}
                to={now}
              />
              <div className="chips">
                <span className="chip">
                  min <b>{value(m.min)}</b>
                </span>
                <span className="chip">
                  avg <b>{value(m.avg)}</b>
                </span>
                <span className="chip">
                  max <b>{value(m.max)}</b>
                </span>
                <span className="chip">
                  σ <b>{value(m.sd)}</b>
                </span>
                <span className="chip">
                  trend <Trend slope={m.slope_per_hour} sd={m.sd} />
                </span>
                <span className={`chip ${m.outliers ? "chip-warn" : ""}`}>
                  outliers <b>{m.outliers}</b>
                </span>
                <span className="chip">
                  readings <b>{m.n}</b>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
