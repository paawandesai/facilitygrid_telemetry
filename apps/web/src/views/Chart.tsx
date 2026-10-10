import { useRef, useState, type MouseEvent } from "react";
import type { MarkPoint, SeriesPoint } from "../api";
import { value } from "../format";

const W = 640;
const H = 180;
const PAD = { l: 44, r: 12, t: 10, b: 22 };

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** Split a bucketed series wherever buckets are missing, so an outage shows as a gap, not a straight line. */
function segments(series: SeriesPoint[]): SeriesPoint[][] {
  if (series.length < 2) return [series];
  let step = Infinity;
  for (let i = 1; i < series.length; i++) step = Math.min(step, series[i][0] - series[i - 1][0]);
  const out: SeriesPoint[][] = [[series[0]]];
  for (let i = 1; i < series.length; i++) {
    if (series[i][0] - series[i - 1][0] > step * 2.5) out.push([]);
    out[out.length - 1].push(series[i]);
  }
  return out;
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

/**
 * One metric over time: the average line, a min–max band per bucket, late
 * readings as hollow rings (kept in history, never current) and outliers as
 * filled dots. Hover shows the bucket under the cursor.
 */
export function LineChart({
  series,
  marks = [],
  from,
  to,
}: {
  series: SeriesPoint[];
  marks?: MarkPoint[];
  from: number;
  to: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (series.length === 0) return <div className="chart-empty muted small">No numeric readings in this window.</div>;

  let lo = Math.min(...series.map((p) => p[2]), ...marks.map((m) => m.v));
  let hi = Math.max(...series.map((p) => p[3]), ...marks.map((m) => m.v));
  if (lo === hi) (lo -= 1), (hi += 1);
  const padY = (hi - lo) * 0.08;
  lo -= padY;
  hi += padY;
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ticks = niceTicks(lo, hi);
  const segs = segments(series);

  const onMove = (e: MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < series.length; i++) if (Math.abs(x(series[i][0]) - px) < Math.abs(x(series[best][0]) - px)) best = i;
    setHover(best);
  };
  const h = hover !== null ? series[hover] : null;

  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">
              {Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : +v.toFixed(2)}
            </text>
          </g>
        ))}
        {[from, (from + to) / 2, to].map((t, i) => (
          <text key={i} className="axis" x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
            {hhmm(t)}
          </text>
        ))}
        {segs.map((s, i) => (
          <g key={i}>
            <path
              className="band"
              d={
                s.map((p, j) => `${j ? "L" : "M"}${x(p[0])},${y(p[3])}`).join("") +
                [...s].reverse().map((p) => `L${x(p[0])},${y(p[2])}`).join("") +
                "Z"
              }
            />
            <path className="line" d={s.map((p, j) => `${j ? "L" : "M"}${x(p[0])},${y(p[1])}`).join("")} />
          </g>
        ))}
        {marks
          .filter((m) => m.late && m.t >= from)
          .map((m, i) => (
            <circle key={`l${i}`} className="mark-late" cx={x(m.t)} cy={y(m.v)} r={4}>
              <title>{`late: ${value(m.v)} taken ${hhmmss(m.t)}, arrived after newer data`}</title>
            </circle>
          ))}
        {marks
          .filter((m) => m.outlier && m.t >= from)
          .map((m, i) => (
            <circle key={`o${i}`} className="mark-outlier" cx={x(m.t)} cy={y(m.v)} r={4.5}>
              <title>{`outlier: ${value(m.v)} at ${hhmmss(m.t)} (${m.z?.toFixed(1)}σ)`}</title>
            </circle>
          ))}
        {h && (
          <g>
            <line className="crosshair" x1={x(h[0])} x2={x(h[0])} y1={PAD.t} y2={H - PAD.b} />
            <circle className="mark-hover" cx={x(h[0])} cy={y(h[1])} r={4} />
          </g>
        )}
      </svg>
      {h && (
        <div className="tooltip" style={{ left: `${(x(h[0]) / W) * 100}%` }}>
          <div className="muted">{hhmmss(h[0])}</div>
          <b>{value(h[1])}</b> avg
          <div className="muted">
            {value(h[2])} – {value(h[3])}
          </div>
        </div>
      )}
    </div>
  );
}

/** A tiny trend line for tables and cards. */
export function Sparkline({ series, width = 96, height = 22 }: { series: SeriesPoint[]; width?: number; height?: number }) {
  if (series.length < 2) return <svg className="spark" width={width} height={height} />;
  const t0 = series[0][0];
  const t1 = series[series.length - 1][0];
  let lo = Math.min(...series.map((p) => p[1]));
  let hi = Math.max(...series.map((p) => p[1]));
  if (lo === hi) (lo -= 1), (hi += 1);
  const x = (t: number) => 1 + ((t - t0) / (t1 - t0 || 1)) * (width - 2);
  const y = (v: number) => 2 + (1 - (v - lo) / (hi - lo)) * (height - 4);
  const last = series[series.length - 1];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path className="line" d={series.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")} />
      <circle className="spark-end" cx={x(last[0])} cy={y(last[1])} r={2} />
    </svg>
  );
}
