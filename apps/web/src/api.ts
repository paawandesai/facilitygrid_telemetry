import type { DeviceSummary, GatewaySummary, ReadingRow, ServerEvent, ClaimInput } from "@fg/shared";
import { QueryClient } from "@tanstack/react-query";

const BASE = "/api";

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.json();
}

export interface Stats {
  devices: number;
  unclaimed: number;
  readings: number;
  duplicates_absorbed: number;
  late: number;
  anomalies: number;
  stale_after_ms: number;
}

export interface Anomaly {
  id: number;
  kind: string;
  gateway_id: string | null;
  device_id: string | null;
  detail: unknown;
  created_at: string;
}

export const api = {
  devices: (status?: "claimed" | "unclaimed") => get<DeviceSummary[]>(`/devices${status ? `?status=${status}` : ""}`),
  device: (id: string) => get<DeviceSummary>(`/devices/${encodeURIComponent(id)}`),
  readings: (id: string) => get<ReadingRow[]>(`/devices/${encodeURIComponent(id)}/readings?limit=1000`),
  gateways: () => get<GatewaySummary[]>("/gateways"),
  stats: () => get<Stats>("/stats"),
  anomalies: () => get<Anomaly[]>("/anomalies"),
  claim: async (id: string, body: ClaimInput): Promise<DeviceSummary> => {
    const res = await fetch(`${BASE}/devices/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  },
};

export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 5000, staleTime: 1000 } },
});

/**
 * One SSE connection for the whole app. Events are hints to refetch: the
 * REST endpoints stay the source of truth, so a missed event costs at most one
 * polling interval.
 */
export function connectEvents(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void) {
  let pending: number | null = null;
  const invalidate = () => {
    if (pending !== null) return;
    pending = window.setTimeout(() => {
      pending = null;
      queryClient.invalidateQueries();
    }, 250);
  };
  const es = new EventSource(`${BASE}/events`);
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.onmessage = (msg) => {
    try {
      const e = JSON.parse(msg.data) as ServerEvent;
      onEvent(e);
      invalidate();
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}
