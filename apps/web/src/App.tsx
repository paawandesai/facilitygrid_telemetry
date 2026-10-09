import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ServerEvent } from "@fg/shared";
import { api, connectEvents } from "./api";
import { Board } from "./views/Board";
import { Inbox } from "./views/Inbox";
import { Gateways } from "./views/Gateways";
import { DeviceDetail } from "./views/DeviceDetail";

type Route = { view: "board" } | { view: "inbox" } | { view: "gateways" } | { view: "device"; id: string };

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("device/")) return { view: "device", id: decodeURIComponent(h.slice(7)) };
  if (h === "inbox") return { view: "inbox" };
  if (h === "gateways") return { view: "gateways" };
  return { view: "board" };
}

interface Toast {
  id: number;
  text: string;
  href?: string;
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats });

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(
    () =>
      connectEvents((e: ServerEvent) => {
        if (e.type === "device_discovered") {
          const t = { id: Date.now() + Math.random(), text: `New device ${e.device_id} reported by ${e.gateway_id}`, href: "#/inbox" };
          setToasts((ts) => [...ts.slice(-3), t]);
          setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 6000);
        }
      }, setLive),
    [],
  );

  const s = stats.data;
  const tab = (view: Route["view"], href: string, label: ReactNode) => (
    <a className={`tab ${route.view === view ? "active" : ""}`} href={href}>
      {label}
    </a>
  );

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">◆</span> FacilityGrid <span className="muted">Telemetry</span>
        </div>
        <nav>
          {tab("board", "#/", "Equipment")}
          {tab(
            "inbox",
            "#/inbox",
            <>
              Unregistered {s && s.unclaimed > 0 && <span className="count">{s.unclaimed}</span>}
            </>,
          )}
          {tab("gateways", "#/gateways", "Gateways")}
        </nav>
        <div className={`live ${live ? "on" : ""}`} title="Live updates via Server-Sent Events">
          <span className="dot" /> {live ? "Live" : "Reconnecting"}
        </div>
      </header>

      {s && (
        <div className="stats">
          <Stat label="Devices" value={s.devices} />
          <Stat label="Readings stored" value={s.readings} />
          <Stat label="Duplicates absorbed" value={s.duplicates_absorbed} />
          <Stat label="Late (kept, not current)" value={s.late} />
          <Stat label="Anomalies" value={s.anomalies} warn={s.anomalies > 0} />
        </div>
      )}

      <main>
        {route.view === "board" && <Board />}
        {route.view === "inbox" && <Inbox />}
        {route.view === "gateways" && <Gateways />}
        {route.view === "device" && <DeviceDetail id={route.id} />}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <a key={t.id} className="toast" href={t.href}>
            {t.text}
          </a>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? "warn" : ""}`}>
      <div className="stat-value">{value.toLocaleString()}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
