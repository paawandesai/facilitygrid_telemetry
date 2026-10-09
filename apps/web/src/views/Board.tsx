import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { MetricTable } from "./MetricTable";
import { useNow } from "./useNow";

export function Board() {
  const now = useNow();
  const q = useQuery({ queryKey: ["devices", "claimed"], queryFn: () => api.devices("claimed") });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error) return <p className="error">Could not load equipment: {String(q.error)}</p>;
  const devices = q.data ?? [];
  return (
    <section>
      <h1>Equipment</h1>
      <p className="muted">
        Current state is the newest reading by when it was taken, not when it arrived. A value is marked stale when its
        gateway has gone silent.
      </p>
      {devices.length === 0 ? (
        <div className="empty">
          No registered equipment yet. Devices appear under <a href="#/inbox">Unregistered</a> when a gateway first
          reports them; claim them there.
        </div>
      ) : (
        <div className="grid">
          {devices.map((d) => {
            const anyStale = d.metrics.some((m) => m.stale);
            return (
              <a key={d.device_id} className={`card ${anyStale ? "card-stale" : ""}`} href={`#/device/${encodeURIComponent(d.device_id)}`}>
                <div className="card-head">
                  <div>
                    <div className="card-title">{d.name}</div>
                    <div className="muted small">
                      {[d.equipment_type, d.location].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <code className="small">{d.device_id}</code>
                </div>
                <MetricTable metrics={d.metrics} now={now} />
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
