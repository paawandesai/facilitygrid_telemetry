import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeviceSummary } from "@fg/shared";
import { api, ApiError } from "../api";
import { ago, value } from "../format";
import { useNow } from "./useNow";

export function Inbox() {
  const now = useNow();
  const q = useQuery({ queryKey: ["devices", "unclaimed"], queryFn: () => api.devices("unclaimed") });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error) return <p className="error">Could not load devices: {String(q.error)}</p>;
  const devices = q.data ?? [];
  return (
    <section>
      <h1>Unregistered devices</h1>
      <p className="muted">
        Devices a gateway is reporting that nobody has registered yet. Each is recorded exactly once, however many
        gateways report it at the same moment. Claim one to add it to the equipment board.
      </p>
      {devices.length === 0 ? (
        <div className="empty">Nothing waiting. New devices show up here live.</div>
      ) : (
        <div className="list">
          {devices.map((d) => (
            <InboxRow key={d.device_id} d={d} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function InboxRow({ d, now }: { d: DeviceSummary; now: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [location, setLocation] = useState("");
  const qc = useQueryClient();
  const claim = useMutation({
    mutationFn: () => api.claim(d.device_id, { name, equipment_type: type || undefined, location: location || undefined }),
    onSettled: () => qc.invalidateQueries(),
  });
  const conflict = claim.error instanceof ApiError && claim.error.status === 409;

  return (
    <div className="row">
      <div className="row-main">
        <div>
          <a href={`#/device/${encodeURIComponent(d.device_id)}`}>
            <code>{d.device_id}</code>
          </a>
          <div className="muted small">
            first seen {ago(d.first_seen_at, now)} via <b>{d.first_seen_gateway_id}</b> · reported by{" "}
            {d.gateways.join(", ")} · {d.reading_count} readings
          </div>
        </div>
        <div className="chips">
          {d.metrics.map((m) => (
            <span key={m.metric} className="chip">
              {m.metric} <b>{value(m.value)}</b>
            </span>
          ))}
        </div>
        {!open && (
          <button className="primary" onClick={() => setOpen(true)}>
            Claim
          </button>
        )}
      </div>
      {open && (
        <form
          className="claim"
          onSubmit={(e) => {
            e.preventDefault();
            claim.mutate();
          }}
        >
          <input required placeholder="Name (e.g. AHU-3 North)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Type (e.g. Air handler)" value={type} onChange={(e) => setType(e.target.value)} />
          <input placeholder="Location (e.g. Roof, L4)" value={location} onChange={(e) => setLocation(e.target.value)} />
          <button className="primary" disabled={claim.isPending || !name.trim()}>
            {claim.isPending ? "Claiming…" : "Register equipment"}
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {conflict && <span className="error">Someone else already claimed this device.</span>}
          {claim.error && !conflict && <span className="error">{String(claim.error)}</span>}
        </form>
      )}
    </div>
  );
}
