"""Local gazetteer: resolve place names to coordinates without trusting model numbers."""
import difflib
import json
import re
import unicodedata
from functools import lru_cache

from . import countries
from .config import STATIC_DIR

ALIASES = {
    "kyiv": "kiev", "odesa": "odessa", "oryol": "orel", "hodeidah": "al hudaydah",
    "sana'a": "sanaa", "sanaa": "sanaa", "zaporizhzhia": "zaporizhzhya", "mykolaiv": "mykolayiv",
    "kryvyi rih": "kryvyy rih", "lviv": "lviv", "gaza city": "gaza", "tel aviv": "tel aviv-yafo",
    "sevastopol": "sevastopol", "jerusalem": "jerusalem", "al-fashir": "el fasher", "el-fasher": "el fasher",
    "kharkov": "kharkiv", "nikolaev": "mykolayiv", "dnipropetrovsk": "dnipro", "port-sudan": "port sudan",
}
CAMEO_TO_NE = countries.CAMEO_TO_NE


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower().replace("’", "'").replace("'", "")
    s = re.sub(r"\b(city|oblast|region|province|district|port of|port|governorate|airport|airbase|air base|naval base|refinery|plant|area|outskirts|near)\b", " ", s)
    s = re.sub(r"[^a-z0-9 -]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


@lru_cache
def _places() -> dict:
    g = json.load(open(STATIC_DIR / "data" / "places.geojson"))
    idx: dict[str, list] = {}
    for f in g["features"]:
        p = f["properties"]
        rec = (p["adm0_a3"], round(p["latitude"], 4), round(p["longitude"], 4), p.get("pop_max") or 0, p["name"])
        for key in {p.get("name"), p.get("nameascii"), p.get("namealt"), p.get("meganame")}:
            if key:
                for part in re.split(r"[|;]", key):
                    n = _norm(part)
                    if n:
                        idx.setdefault(n, []).append(rec)
    return idx


def _country_geom(iso3: str):
    g = _countries_geo()
    return g.get(iso3)


@lru_cache
def _countries_geo() -> dict:
    g = json.load(open(STATIC_DIR / "data" / "countries.geojson"))
    return {f["properties"]["ADM0_A3"]: f["geometry"] for f in g["features"]}


def _in_ring(lon, lat, ring) -> bool:
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        if (y0 > lat) != (y1 > lat):
            x = x0 + (lat - y0) * (x1 - x0) / (y1 - y0)
            if x > lon:
                inside = not inside
    return inside


def point_in_country(lon: float, lat: float, iso3: str, pad: float = 1.5) -> bool:
    """Inside the country polygon, or inside its bounding box padded by `pad` degrees
    (borders in the 110m file are coarse and disputed areas such as Crimea are drawn
    on the other side, so a strict polygon test rejects real places)."""
    geom = _country_geom(iso3)
    if not geom:
        return False
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    if any(_in_ring(lon, lat, poly[0]) for poly in polys):
        return True
    xs = [x for poly in polys for x, _ in poly[0]]
    ys = [y for poly in polys for _, y in poly[0]]
    return min(xs) - pad <= lon <= max(xs) + pad and min(ys) - pad <= lat <= max(ys) + pad


def resolve(place: str | None, country: str | None, lat=None, lon=None) -> dict | None:
    """Return {name, lat, lon, country, precision} or None. precision: city | approx | country."""
    iso3 = countries.iso3(country) if country else None
    name = (place or "").strip()
    n = _norm(name)
    n = ALIASES.get(n, n)
    if n and n != _norm(iso3 or "") and n not in {_norm(countries.table()["iso3"].get(iso3, {}).get("name", "")) if iso3 else ""}:
        idx = _places()
        cands = idx.get(n) or []
        if not cands:
            keys = difflib.get_close_matches(n, idx.keys(), n=3, cutoff=0.86)
            cands = [c for k in keys for c in idx[k]]
        if iso3:
            same = [c for c in cands if c[0] == iso3]
            cands = same or ([] if len(n) < 5 else cands)
        if cands:
            c = max(cands, key=lambda r: r[3])
            return {"name": name, "lat": c[1], "lon": c[2], "country": c[0], "precision": "city"}
    # model coordinates, accepted only when they sit inside the named country
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        lat = lon = None
    if lat is not None and iso3 and point_in_country(lon, lat, iso3):
        return {"name": name or countries.table()["iso3"][iso3]["name"], "lat": round(lat, 3), "lon": round(lon, 3),
                "country": iso3, "precision": "approx"}
    if iso3:
        rec = countries.table()["iso3"][iso3]
        return {"name": name or rec["name"], "lat": rec["lat"], "lon": rec["lon"], "country": rec["iso3"], "precision": "country"}
    return None
