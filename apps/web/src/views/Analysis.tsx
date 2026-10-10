import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { value } from "../format";
import { Sparkline } from "./Chart";

const WINDOWS = [
  { minutes: 15, label: "15m" },
  { minutes: 60, label: "1h" },
  { minutes: 360, label: "6h" },
  { minutes: 1440, label: "24h" },
];

export function useWindow(initial: number) {
  return useState(initial);
}

export function WindowPicker({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Time window">
      {WINDOWS.map((w) => (
        <button key={w.minutes} className={w.minutes === minutes ? "on" : ""} onClick={() => onChange(w.minutes)}>
          {w.label}
        </button>
      ))}
    </div>
  );
}

/** Slope per hour, shown as flat unless an hour of it would move the value by a quarter of its spread. */
export function Trend({ slope, sd }: { slope: number | null; sd: number }) {
  if (slope === null || !Number.isFinite(slope)) return <b>—</b>;
  const flat = Math.abs(slope) < Math.max(sd * 0.25, 1e-9);
  const arrow = flat ? "→" : slope > 0 ? "↗" : "↘";
  return (
    <b title={`${slope >= 0 ? "+" : ""}${slope.toFixed(3)} per hour (least-squares fit)`}>
      {arrow} {flat ? "flat" : `${slope > 0 ? "+" : ""}${value(slope)}/h`}
    </b>
  );
}

export function Analysis() {
  const [minutes, setMinutes] = useWindow(60);
  const q = useQuery({ queryKey: ["analysis", minutes, 60], queryFn: () => api.analysis(minutes, 60) });
  const devices = useQuery({ queryKey: ["devices", "all"], queryFn: () => api.devices() });
  const names = new Map((devices.data ?? []).map((d) => [d.device_id, d]));
  const rows = q.data ?? [];
  const flagged = rows.filter((r) => r.outliers > 0).sort((a, b) => b.outliers - a.outliers);

  return (
    <section>
      <div className="section-head">
        <h1>Analysis</h1>
        <WindowPicker minutes={minutes} onChange={setMinutes} />
      </div>
      <p className="muted">
        Every numeric metric over the window, computed from full history (late readings included). An outlier is a
        reading more than 3σ from that metric's mean for the window. Trend is a least-squares slope per hour.
      </p>

      {flagged.length > 0 && (
        <div className="callout">
          <b>Needs a look:</b>{" "}
          {flagged.slice(0, 6).map((r, i) => (
            <span key={`${r.device_id}/${r.metric}`}>
              {i > 0 && ", "}
              <a href={`#/device/${encodeURIComponent(r.device_id)}`}>
                {names.get(r.device_id)?.name ?? r.device_id} {r.metric}
              </a>{" "}
              ({r.outliers} outlier{r.outliers === 1 ? "" : "s"})
            </span>
          ))}
        </div>
      )}

      {q.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty">No numeric readings in this window yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Equipment</th>
              <th>Metric</th>
              <th>Trend</th>
              <th className="num">Last</th>
              <th className="num">Min</th>
              <th className="num">Avg</th>
              <th className="num">Max</th>
              <th className="num">σ</th>
              <th>Slope</th>
              <th className="num">Outliers</th>
              <th className="num">Readings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const d = names.get(r.device_id);
              const first = i === 0 || rows[i - 1].device_id !== r.device_id;
              return (
                <tr key={`${r.device_id}/${r.metric}`} className={first ? "group-start" : ""}>
                  <td>
                    {first && (
                      <a href={`#/device/${encodeURIComponent(r.device_id)}`}>
                        {d?.name ?? <code>{r.device_id}</code>}
                        {d?.status === "unclaimed" && <span className="badge warn">unregistered</span>}
                      </a>
                    )}
                  </td>
                  <td className="muted">{r.metric}</td>
                  <td>
                    <Sparkline series={r.series} />
                  </td>
                  <td className="num">
                    <b>{value(r.last)}</b>
                  </td>
                  <td className="num">{value(r.min)}</td>
                  <td className="num">{value(r.avg)}</td>
                  <td className="num">{value(r.max)}</td>
                  <td className="num muted">{value(r.sd)}</td>
                  <td>
                    <Trend slope={r.slope_per_hour} sd={r.sd} />
                  </td>
                  <td className="num">{r.outliers > 0 ? <span className="badge warn">{r.outliers}</span> : "0"}</td>
                  <td className="num muted">{r.n.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
