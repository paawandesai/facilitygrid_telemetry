#!/usr/bin/env python3
"""
Demo feed: a small commissioned building that never stops reporting.

Opt-in only (docker-compose.demo.yml runs it); the plain `docker-compose up`
starts empty, as the brief asks. Python 3 standard library only.

What it does
  1. Backfills the last few hours of history for 11 pieces of equipment on
     three gateways, then claims them so the Equipment board is populated.
  2. Streams live readings: each gateway posts one batch every 10 s.
  3. Injects the faults the system is built to absorb, on a 10-minute cycle:
       - gw-plant "loses the ack" on some batches and resends them byte for byte
       - gw-floor3 drops off for 90 s, then sends its newest reading first and
         flushes the buffered backlog after it (late, partly via the backlog lane)
       - a brand-new device is reported by two gateways at the same instant
       - CH-1 and P-1 throw short spikes that the Analysis page flags as outliers

Every value is a pure function of (device, metric, event time) and the sequence
number is the event time in seconds, so a restarted feed resends identical
readings (absorbed as duplicates) instead of conflicting ones.

  python3 scripts/demo_feed.py --target http://localhost:8080 --api http://localhost:8080/api
"""

import argparse
import hashlib
import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

TICK_S = 10            # live reporting interval per gateway
BACKFILL_STEP_S = 60   # history resolution for the backfill
CYCLE_S = 600          # fault cycle
OUTAGE = (120, 210)    # gw-floor3 silent for this part of each cycle
RACE_AT = 300          # new device appears at this point of each cycle

# metric: (base, slow amplitude, fast amplitude, noise, decimals)
AHU = {"supply_air_temp": (13.0, 1.2, 0.3, 0.15, 2), "return_air_temp": (23.0, 1.0, 0.2, 0.1, 2),
       "fan_speed": (65.0, 12.0, 3.0, 1.0, 1), "status": "running"}
CHILLER = {"chw_supply_temp": (6.7, 0.4, 0.15, 0.05, 2), "chw_return_temp": (12.2, 0.8, 0.2, 0.1, 2),
           "power_kw": (180.0, 45.0, 8.0, 3.0, 1), "status": "running"}

DEVICES = {
    "AHU-1": ("Air handler 1", "AHU", "Roof, north", AHU),
    "AHU-2": ("Air handler 2", "AHU", "Roof, south", AHU),
    "RTU-1": ("Rooftop unit 1", "RTU", "Roof, east",
              {"supply_air_temp": (14.0, 1.5, 0.4, 0.2, 2), "power_kw": (22.0, 6.0, 1.5, 0.5, 1)}),
    "CH-1": ("Chiller 1", "Chiller", "Central plant", CHILLER),
    "CH-2": ("Chiller 2", "Chiller", "Central plant", CHILLER),
    "CT-1": ("Cooling tower 1", "Cooling tower", "Central plant",
             {"cw_supply_temp": (29.0, 1.5, 0.3, 0.15, 2), "fan_speed": (55.0, 15.0, 4.0, 1.0, 1)}),
    "P-1": ("Chilled water pump 1", "Pump", "Central plant",
            {"flow_lps": (42.0, 4.0, 1.0, 0.4, 1), "vibration_mm_s": (2.1, 0.3, 0.1, 0.05, 2)}),
    "VAV-301": ("VAV box 301", "VAV", "Floor 3, open office",
                {"zone_temp": (22.0, 0.8, 0.2, 0.1, 2), "damper_pct": (45.0, 15.0, 5.0, 2.0, 0)}),
    "VAV-302": ("VAV box 302", "VAV", "Floor 3, conference",
                {"zone_temp": (22.5, 1.0, 0.3, 0.1, 2), "damper_pct": (55.0, 18.0, 6.0, 2.0, 0)}),
    "VAV-303": ("VAV box 303", "VAV", "Floor 3, corner office",
                {"zone_temp": (21.5, 0.7, 0.2, 0.1, 2), "damper_pct": (35.0, 12.0, 4.0, 2.0, 0)}),
    "MTR-MAIN": ("Main electrical meter", "Meter", "Basement",
                 {"power_kw": (420.0, 90.0, 15.0, 6.0, 1)}),
}
GATEWAYS = {
    "gw-roof": (0, ["AHU-1", "AHU-2", "RTU-1"]),
    "gw-plant": (3, ["CH-1", "CH-2", "CT-1", "P-1"]),
    "gw-floor3": (6, ["VAV-301", "VAV-302", "VAV-303", "MTR-MAIN"]),
}
# Devices that turn up unannounced during the demo (one per cycle), for the race and the claim flow.
NEW_DEVICES = [f"VAV-{n}" for n in range(304, 314)]
NEW_DEVICE_METRICS = {"zone_temp": (22.0, 0.8, 0.2, 0.1, 2), "damper_pct": (40.0, 15.0, 5.0, 2.0, 0)}


def unit(*parts):
    """Deterministic pseudo-random number in [-1, 1) from the arguments."""
    h = hashlib.sha256("/".join(map(str, parts)).encode()).digest()
    return int.from_bytes(h[:8], "big") / 2**63 - 1


def value_at(device, metric, spec, t):
    if isinstance(spec, str):
        return spec
    base, slow, fast, noise, decimals = spec
    phase = unit(device, metric, "phase") * math.pi
    v = (base + slow * math.sin(2 * math.pi * t / 7200 + phase)
         + fast * math.sin(2 * math.pi * t / 600 + phase * 2) + noise * unit(device, metric, t))
    # Short spikes for the outlier detector: 20 s every 15 min on CH-1, every 23 min on P-1.
    if device == "CH-1" and metric == "chw_supply_temp" and t % 900 < 20:
        v += 4.5
    if device == "P-1" and metric == "vibration_mm_s" and t % 1380 < 20:
        v += 5.0
    return round(v, decimals) if decimals else int(round(v))


def metrics_of(device):
    return DEVICES[device][3] if device in DEVICES else NEW_DEVICE_METRICS


def iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat()


def readings(gateway, devices, t):
    return [
        {"gateway_id": gateway, "device_id": d, "metric": m, "value": value_at(d, m, spec, t),
         "event_time": iso(t), "sequence": int(t)}
        for d in devices for m, spec in metrics_of(d).items()
    ]


class Feed:
    def __init__(self, target, api):
        self.ingest = target.rstrip("/") + "/ingest/readings"
        self.api = api.rstrip("/")
        self.lock = threading.Lock()
        self.extra = []  # new devices discovered during this run, reported by gw-floor3

    def log(self, msg):
        print(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {msg}", flush=True)

    def request(self, method, url, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, None

    def post(self, batch):
        """Like a gateway with a buffer: keep retrying until the API accepts it (202)."""
        delay = 0.5
        while True:
            try:
                status, _ = self.request("POST", self.ingest, batch)
                if status == 202:
                    return
                if status in (400, 422):
                    self.log(f"rejected with {status}; dropping {len(batch)} readings")
                    return
            except (urllib.error.URLError, OSError) as e:
                status = e
            self.log(f"ingest not available ({status}); retrying in {delay:.1f}s")
            time.sleep(delay)
            delay = min(delay * 2, 5)

    def wait_for_api(self):
        while True:
            try:
                if self.request("GET", self.api + "/healthz")[0] == 200:
                    return
            except (urllib.error.URLError, OSError):
                pass
            self.log("waiting for the API")
            time.sleep(2)

    def backfill(self, hours):
        status, device = self.request("GET", self.api + "/devices/AHU-1")
        if status == 200 and device and device.get("status") == "claimed":
            self.log("demo building already present; skipping backfill")
            return
        end = int(time.time()) - 90
        start = end - int(hours * 3600)
        self.log(f"backfilling {hours}h of history")
        for gateway, (offset, devices) in GATEWAYS.items():
            batch = []
            for t in range(start - start % BACKFILL_STEP_S + offset, end, BACKFILL_STEP_S):
                batch += readings(gateway, devices, t)
                if len(batch) >= 500:
                    self.post(batch)
                    batch = []
            if batch:
                self.post(batch)
        self.claim_all()

    def claim_all(self):
        pending = dict(DEVICES)
        for _ in range(60):
            for device_id, (name, kind, location, _) in list(pending.items()):
                status, _ = self.request("POST", f"{self.api}/devices/{device_id}/claim",
                                         {"name": name, "equipment_type": kind, "location": location,
                                          "claimed_by": "demo"})
                if status in (200, 409):
                    del pending[device_id]
            if not pending:
                self.log(f"claimed {len(DEVICES)} devices")
                return
            time.sleep(1)  # the worker hasn't registered them yet
        self.log(f"could not claim {sorted(pending)}")

    def known_new_devices(self):
        status, devices = self.request("GET", self.api + "/devices")
        ids = {d["device_id"] for d in devices or []} if status == 200 else set()
        return [d for d in NEW_DEVICES if d in ids]

    def gateway_loop(self, gateway):
        offset, devices = GATEWAYS[gateway]
        buffered = []
        while True:
            n = int(time.time())
            t = n - (n - offset) % TICK_S + TICK_S  # next tick for this gateway
            time.sleep(max(0, t - time.time()))
            with self.lock:
                current = devices + (self.extra if gateway == "gw-floor3" else [])
            batch = readings(gateway, current, t)
            phase = t % CYCLE_S

            if gateway == "gw-floor3" and OUTAGE[0] <= phase < OUTAGE[1]:
                if not buffered:
                    self.log("gw-floor3 offline, buffering")
                buffered += batch
                continue
            if buffered:
                # Back online: the live reading goes first, then the backlog it held.
                self.post(batch)
                self.post(buffered)
                self.log(f"gw-floor3 back; flushed {len(buffered)} buffered readings after the live one")
                buffered = []
                continue

            self.post(batch)
            if gateway == "gw-plant" and unit("resend", t) > 0.4:
                time.sleep(0.5)
                self.post(batch)  # the ack was "lost"; resend unchanged

    def race_loop(self):
        while True:
            now = time.time()
            wait = (RACE_AT - now % CYCLE_S) % CYCLE_S or CYCLE_S
            time.sleep(wait)
            with self.lock:
                taken = set(self.extra)
            fresh = [d for d in NEW_DEVICES if d not in taken]
            if not fresh:
                continue
            device = fresh[0]
            t = time.time()
            barrier = threading.Barrier(2)

            def report(gw):
                barrier.wait()
                self.post([{"gateway_id": gw, "device_id": device, "metric": "zone_temp",
                            "value": value_at(device, "zone_temp", NEW_DEVICE_METRICS["zone_temp"], int(t)),
                            "event_time": iso(t), "sequence": 0}])

            threads = [threading.Thread(target=report, args=(gw,)) for gw in ("gw-roof", "gw-floor3")]
            for th in threads:
                th.start()
            for th in threads:
                th.join()
            self.log(f"race: {device} reported by gw-roof and gw-floor3 at once")
            with self.lock:
                self.extra.append(device)

    def run(self, backfill_hours):
        self.wait_for_api()
        if backfill_hours > 0:
            self.backfill(backfill_hours)
        self.extra = self.known_new_devices()
        threads = [threading.Thread(target=self.gateway_loop, args=(g,), daemon=True) for g in GATEWAYS]
        threads.append(threading.Thread(target=self.race_loop, daemon=True))
        for th in threads:
            th.start()
        self.log("streaming live readings")
        while True:
            time.sleep(3600)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--target", default=os.environ.get("DEMO_TARGET", "http://localhost:8080"),
                   help="base URL for POST /ingest/readings")
    p.add_argument("--api", default=os.environ.get("DEMO_API"),
                   help="base URL of the read API (default: TARGET/api)")
    p.add_argument("--backfill-hours", type=float, default=float(os.environ.get("DEMO_BACKFILL_HOURS", 3)))
    args = p.parse_args()
    Feed(args.target, args.api or args.target.rstrip("/") + "/api").run(args.backfill_hours)


if __name__ == "__main__":
    main()
