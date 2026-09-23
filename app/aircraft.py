"""Military aircraft from public ADS-B aggregators (airplanes.live, falling back to adsb.fi).

Both serve the readsb JSON format and a ready-made /mil filter. We poll about once a
minute into an in-memory history and only ever serve a snapshot at least
AIRCRAFT_DELAY_MIN old, so the map never shows live positions near active fighting.
Trails come from the same history.

Only aircraft that choose to broadcast show up: tankers, ISR, transports, some patrol
planes. Combat aircraft on missions generally fly with transponders off.
"""
import logging
import threading
import time
from collections import deque

import httpx

from .config import AIRCRAFT_DELAY_MIN, AIRCRAFT_POLL_SECONDS, AIRCRAFT_SOURCES, AIRCRAFT_TRAIL_MIN

log = logging.getLogger("aircraft")
UA = "conflict-map/0.1 (+https://github.com/Comm4nd0/conflict-map)"

# ICAO type designator -> (category, friendly name). Anything unlisted is "other".
TYPES = {
    # tankers
    "K35R": ("tanker", "KC-135R Stratotanker"), "K35E": ("tanker", "KC-135E Stratotanker"),
    "KC2": ("tanker", "KC-46 Pegasus"), "K46": ("tanker", "KC-46 Pegasus"), "DC10": ("tanker", "KC-10 Extender"),
    "A332": ("tanker", "A330 MRTT"), "A310": ("tanker", "A310 MRTT"), "IL78": ("tanker", "Il-78"),
    "KC39": ("tanker", "KC-390"), "E390": ("tanker", "KC-390"), "C30J": ("transport", "C-130J Hercules"),
    # surveillance / ISR / AEW / patrol
    "R135": ("isr", "RC-135 Rivet Joint"), "E3TF": ("isr", "E-3 Sentry AWACS"), "E3CF": ("isr", "E-3 Sentry AWACS"),
    "E6": ("isr", "E-6B Mercury"), "E8": ("isr", "E-8 JSTARS"), "E737": ("isr", "E-7 Wedgetail"),
    "E2": ("isr", "E-2 Hawkeye"), "P8": ("isr", "P-8 Poseidon"), "P3": ("isr", "P-3 Orion"),
    "Q4": ("isr", "RQ-4 Global Hawk"), "Q9": ("isr", "MQ-9 Reaper"), "U2": ("isr", "U-2"),
    "R1": ("isr", "Sentinel R1"), "SB39": ("isr", "Saab 340 AEW"), "GLEX": ("isr", "Global Express (ISR?)"),
    "CL60": ("isr", "Challenger (ISR?)"), "B350": ("isr", "King Air (ISR?)"), "PC12": ("isr", "PC-12 (ISR?)"),
    "A50": ("isr", "A-50 Mainstay"), "IL20": ("isr", "Il-20 Coot"), "TU14": ("isr", "Tu-142"),
    # transports
    "C17": ("transport", "C-17 Globemaster III"), "C5M": ("transport", "C-5M Galaxy"), "C5": ("transport", "C-5 Galaxy"),
    "C130": ("transport", "C-130 Hercules"), "A400": ("transport", "A400M Atlas"), "C27J": ("transport", "C-27J Spartan"),
    "C295": ("transport", "C-295"), "CN35": ("transport", "CN-235"), "IL76": ("transport", "Il-76"),
    "AN12": ("transport", "An-12"), "AN26": ("transport", "An-26"), "AN124": ("transport", "An-124"),
    "A124": ("transport", "An-124"), "C2": ("transport", "C-2"), "C40": ("transport", "C-40 Clipper"),
    "B752": ("transport", "C-32 / 757"), "B742": ("transport", "747 (VIP/NAOC)"), "B762": ("transport", "KC-767 / 767"),
    "C12": ("transport", "C-12 Huron"), "C560": ("transport", "UC-35"), "GLF5": ("transport", "C-37 Gulfstream"),
    "GLF4": ("transport", "C-20 Gulfstream"), "A30B": ("transport", "A300"), "Y20": ("transport", "Y-20"),
    # combat
    "F16": ("combat", "F-16"), "F35": ("combat", "F-35"), "F15": ("combat", "F-15"), "F18H": ("combat", "F/A-18"),
    "F18S": ("combat", "F/A-18"), "F22": ("combat", "F-22"), "EUFI": ("combat", "Eurofighter Typhoon"),
    "RFAL": ("combat", "Rafale"), "GRIF": ("combat", "Gripen"), "B52": ("combat", "B-52"), "B1": ("combat", "B-1"),
    "B2": ("combat", "B-2"), "A10": ("combat", "A-10"), "SU27": ("combat", "Su-27"), "SU30": ("combat", "Su-30"),
    "SU34": ("combat", "Su-34"), "TU95": ("combat", "Tu-95"), "TU22": ("combat", "Tu-22M"), "T38": ("combat", "T-38 trainer"),
    "HAWK": ("combat", "Hawk trainer"), "M346": ("combat", "M-346 trainer"),
    # rotary
    "H60": ("heli", "Black Hawk / Seahawk"), "H47": ("heli", "Chinook"), "H64": ("heli", "Apache"),
    "V22": ("heli", "V-22 Osprey"), "NH90": ("heli", "NH90"), "EC45": ("heli", "UH-72 Lakota"),
    "LYNX": ("heli", "Lynx / Wildcat"), "A139": ("heli", "AW139"), "EH10": ("heli", "Merlin"), "PUMA": ("heli", "Puma"),
    "H53": ("heli", "CH-53"), "H53S": ("heli", "CH-53"), "MI8": ("heli", "Mi-8/17"), "AS32": ("heli", "Super Puma"),
}


def classify(t: str) -> tuple[str, str]:
    t = (t or "").upper().strip()
    return TYPES.get(t, ("other", t or "unknown type"))


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def parse(payload: dict) -> dict:
    """readsb JSON -> {hex: record} for airborne aircraft with a fresh position."""
    out = {}
    for a in payload.get("ac") or payload.get("aircraft") or []:
        lat, lon = _num(a.get("lat")), _num(a.get("lon"))
        if lat is None or lon is None or a.get("alt_baro") == "ground":
            continue
        if (_num(a.get("seen_pos")) or 0) > 120:       # stale position
            continue
        hx = str(a.get("hex") or "").lower().lstrip("~")
        if not hx:
            continue
        cat, name = classify(a.get("t"))
        out[hx] = {
            "hex": hx, "lat": round(lat, 4), "lon": round(lon, 4),
            "track": _num(a.get("track")) if _num(a.get("track")) is not None else _num(a.get("true_heading")),
            "alt": _num(a.get("alt_baro")) if _num(a.get("alt_baro")) is not None else _num(a.get("alt_geom")),
            "gs": _num(a.get("gs")),
            "flight": (a.get("flight") or "").strip(), "reg": (a.get("r") or "").strip(),
            "type": (a.get("t") or "").strip(), "desc": (a.get("desc") or "").strip(),
            "cat": cat, "name": name, "squawk": a.get("squawk") or "",
        }
    return out


class Tracker:
    def __init__(self):
        self.hist: deque = deque()     # (timestamp, {hex: record}), oldest first
        self.lock = threading.Lock()
        self.source = None
        self.last_error = None

    def poll(self):
        for name, url in AIRCRAFT_SOURCES:
            try:
                r = httpx.get(url, timeout=20, headers={"User-Agent": UA})
                r.raise_for_status()
                now = time.time()
                snap = parse(r.json())
                self.add(now, snap)
                self.source, self.last_error = name, None
                return len(snap)
            except (httpx.HTTPError, ValueError) as e:
                self.last_error = f"{name}: {e}"
                log.warning("aircraft poll failed (%s): %s", name, e)
        return None

    def add(self, ts: float, snap: dict):
        keep = (AIRCRAFT_DELAY_MIN + AIRCRAFT_TRAIL_MIN + 5) * 60
        with self.lock:
            self.hist.append((ts, snap))
            while self.hist and ts - self.hist[0][0] > keep:
                self.hist.popleft()

    def view(self, now: float | None = None) -> dict:
        """The newest snapshot at least the delay old, plus trails leading up to it."""
        now = now or time.time()
        cutoff = now - AIRCRAFT_DELAY_MIN * 60
        with self.lock:
            past = [(ts, s) for ts, s in self.hist if ts <= cutoff]
        meta = {"delay_min": AIRCRAFT_DELAY_MIN, "source": self.source, "error": self.last_error}
        if not past:
            wait = None
            if self.hist:
                wait = max(1, round((self.hist[0][0] + AIRCRAFT_DELAY_MIN * 60 - now) / 60))
            return {**meta, "as_of": None, "warming_up_min": wait, "aircraft": []}
        as_of, snap = past[-1]
        if cutoff - as_of > 10 * 60:          # polling has stopped: don't keep showing old planes
            return {**meta, "as_of": int(as_of), "warming_up_min": None, "aircraft": []}
        trail_from = as_of - AIRCRAFT_TRAIL_MIN * 60
        trails: dict[str, list] = {}
        for ts, s in past:
            if ts < trail_from:
                continue
            for hx, a in s.items():
                if hx in snap:
                    trails.setdefault(hx, []).append([a["lon"], a["lat"]])
        aircraft = [{**a, "trail": trails.get(hx, [])} for hx, a in snap.items()]
        return {**meta, "as_of": int(as_of), "warming_up_min": None, "aircraft": aircraft}


tracker = Tracker()


def run_forever(stop: threading.Event | None = None):
    while not (stop and stop.is_set()):
        n = tracker.poll()
        if n is not None:
            log.debug("aircraft: %d airborne military", n)
        time.sleep(AIRCRAFT_POLL_SECONDS)
