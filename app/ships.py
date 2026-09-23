"""Military ships from AIS (aisstream.io websocket).

Only vessels that broadcast AIS appear, and most warships switch it off near operations;
naval auxiliaries (USNS, RFA), patrol and coast-guard vessels are the usual catch. A ship
counts as military when its static data says ship type 35 ("military ops") or its name
starts with a navy prefix. Positions are held back SHIPS_DELAY_MIN like aircraft.
"""
import asyncio
import gzip
import json
import logging
import os
import re
import threading
import time

from .config import (AISSTREAM_API_KEY, DATA_DIR, SHIPS_BOXES, SHIPS_DELAY_MIN, SHIPS_STALE_MIN,
                     SHIPS_TRAIL_MIN)

log = logging.getLogger("ships")
URL = "wss://stream.aisstream.io/v0/stream"
HISTORY_FILE = DATA_DIR / "ships-history.json.gz"
NAVY = re.compile(r"^(USS|USNS|USCGC|HMS|HMCS|HMAS|HMNZS|RFA|FS|FGS|ITS|ESPS|HNLMS|HNOMS|HDMS|HSWMS|KRI|INS|PNS|"
                  r"TCG|ROKS|JS|RSS|BNS|NRP|ORP|ENS|SPS|SNS|HS|KD|WARSHIP|NAVY|COAST ?GUARD)\b", re.I)
MIL_TYPES = {35}


def is_military(name: str, ship_type) -> bool:
    return (isinstance(ship_type, int) and ship_type in MIL_TYPES) or bool(NAVY.match((name or "").strip()))


class Fleet:
    def __init__(self):
        self.lock = threading.Lock()
        self.static: dict[int, dict] = {}      # mmsi -> {name, type, callsign, dest}
        self.track: dict[int, list] = {}       # mmsi -> [[ts, lat, lon, sog, cog, heading], ...] (military only)
        self.connected = False
        self.last_error = None
        self.msgs = 0

    # ---- message handling
    def handle(self, msg: dict, now: float | None = None):
        now = now or time.time()
        self.msgs += 1
        kind = msg.get("MessageType")
        meta = msg.get("MetaData") or {}
        mmsi = meta.get("MMSI")
        if not isinstance(mmsi, int):
            return
        body = (msg.get("Message") or {}).get(kind) or {}
        name = (meta.get("ShipName") or body.get("Name") or "").strip()
        if kind in ("ShipStaticData", "StaticDataReport"):
            t = body.get("Type")
            if t is None and isinstance(body.get("ReportB"), dict):
                t = body["ReportB"].get("ShipType")
            with self.lock:
                s = self.static.setdefault(mmsi, {})
                if name:
                    s["name"] = name
                if isinstance(t, int):
                    s["type"] = t
                if body.get("CallSign"):
                    s["callsign"] = body["CallSign"].strip()
                if body.get("Destination"):
                    s["dest"] = body["Destination"].strip()
            return
        if kind not in ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"):
            return
        lat, lon = body.get("Latitude", meta.get("latitude")), body.get("Longitude", meta.get("longitude"))
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or abs(lat) > 90 or abs(lon) > 180:
            return
        with self.lock:
            s = self.static.setdefault(mmsi, {})
            if name and not s.get("name"):
                s["name"] = name
            if not is_military(s.get("name", ""), s.get("type")):
                return
            hd = body.get("TrueHeading")
            pts = self.track.setdefault(mmsi, [])
            if pts and now - pts[-1][0] < 60:        # one point a minute is plenty for ships
                return
            pts.append([now, round(lat, 4), round(lon, 4), body.get("Sog"), body.get("Cog"), hd if hd != 511 else None])

    def prune(self, now: float | None = None):
        now = now or time.time()
        keep = (SHIPS_DELAY_MIN + max(SHIPS_TRAIL_MIN, SHIPS_STALE_MIN) + 5) * 60
        with self.lock:
            for mmsi in list(self.track):
                pts = [p for p in self.track[mmsi] if now - p[0] <= keep]
                if pts:
                    self.track[mmsi] = pts
                else:
                    del self.track[mmsi]
            if len(self.static) > 200000:              # static data for every ship seen; cap memory
                mil = {m: v for m, v in self.static.items() if m in self.track or is_military(v.get("name", ""), v.get("type"))}
                self.static = mil

    def view(self, now: float | None = None) -> dict:
        now = now or time.time()
        cutoff = now - SHIPS_DELAY_MIN * 60
        out = []
        with self.lock:
            for mmsi, pts in self.track.items():
                past = [p for p in pts if p[0] <= cutoff]
                if not past or cutoff - past[-1][0] > SHIPS_STALE_MIN * 60:
                    continue
                ts, lat, lon, sog, cog, hd = past[-1]
                s = self.static.get(mmsi, {})
                trail = [[p[2], p[1]] for p in past if p[0] >= ts - SHIPS_TRAIL_MIN * 60]
                out.append({"mmsi": mmsi, "name": s.get("name") or str(mmsi), "type": s.get("type"),
                            "callsign": s.get("callsign", ""), "dest": s.get("dest", ""),
                            "lat": lat, "lon": lon, "sog": sog, "cog": cog, "heading": hd if hd is not None else cog,
                            "seen": int(ts), "trail": trail})
        return {"enabled": bool(AISSTREAM_API_KEY), "delay_min": SHIPS_DELAY_MIN, "connected": self.connected,
                "error": self.last_error, "ships": out}

    # ---- persistence (same pattern as aircraft)
    def save(self):
        with self.lock:
            data = {"v": 1, "track": {str(k): v for k, v in self.track.items()},
                    "static": {str(k): v for k, v in self.static.items() if k in self.track}}
        tmp = HISTORY_FILE.with_suffix(".tmp")
        try:
            HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=5) as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, HISTORY_FILE)
        except OSError as e:
            log.warning("could not save ship history: %s", e)

    def load(self):
        try:
            with gzip.open(HISTORY_FILE, "rt", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return 0
        except (OSError, ValueError, EOFError) as e:
            log.warning("ignoring unreadable ship history: %s", e)
            return 0
        with self.lock:
            self.track = {int(k): v for k, v in (data.get("track") or {}).items()}
            self.static.update({int(k): v for k, v in (data.get("static") or {}).items()})
        self.prune()
        log.info("restored %d ships from history", len(self.track))
        return len(self.track)


fleet = Fleet()


async def _stream():
    import websockets
    sub = {"APIKey": AISSTREAM_API_KEY, "BoundingBoxes": SHIPS_BOXES,
           "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport",
                                  "ShipStaticData", "StaticDataReport"]}
    backoff = 5
    last_save = time.time()
    while True:
        try:
            async with websockets.connect(URL, ping_interval=30, max_size=2**20) as ws:
                await ws.send(json.dumps(sub))
                fleet.connected, fleet.last_error, backoff = True, None, 5
                log.info("aisstream connected (%d boxes)", len(SHIPS_BOXES))
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    if "error" in msg:
                        raise RuntimeError(msg["error"])
                    fleet.handle(msg)
                    if time.time() - last_save > 120:
                        fleet.prune()
                        await asyncio.to_thread(fleet.save)
                        last_save = time.time()
        except Exception as e:  # noqa: BLE001
            fleet.connected = False
            fleet.last_error = str(e)[:200]
            log.warning("aisstream: %s; reconnecting in %ds", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 600)


def run_forever():
    fleet.load()
    if not AISSTREAM_API_KEY:
        log.info("ships layer off: set AISSTREAM_API_KEY to enable")
        return
    asyncio.run(_stream())
