"""Country lookup built from the Natural Earth GeoJSON: centroids + code mappings."""
import json
from functools import lru_cache

from .config import STATIC_DIR

# CAMEO / odd codes -> Natural Earth ADM0_A3
CAMEO_TO_NE = {"KSV": "KOS", "PSE": "PSE", "TWN": "TWN", "SSD": "SDS", "SOM": "SOM"}


def _ring_area_centroid(ring):
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if abs(a) < 1e-12:
        return 0.0, ring[0][0], ring[0][1]
    a *= 0.5
    return abs(a), cx / (6 * a), cy / (6 * a)


def _centroid(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    best = (0.0, 0.0, 0.0)
    for p in polys:
        area, x, y = _ring_area_centroid(p[0])
        if area > best[0]:
            best = (area, x, y)
    return round(best[2], 3), round(best[1], 3)


@lru_cache
def table() -> dict:
    g = json.load(open(STATIC_DIR / "data" / "countries.geojson"))
    by_iso3, by_fips = {}, {}
    for f in g["features"]:
        p = f["properties"]
        iso3 = p.get("ADM0_A3")
        iso2 = p.get("ISO_A2_EH") or p.get("ISO_A2")
        fips = p.get("FIPS_10")
        lat, lon = _centroid(f["geometry"])
        rec = {"iso3": iso3, "iso2": iso2 if iso2 and iso2 != "-99" else None,
               "fips": fips if fips and fips != "-99" else None,
               "name": p.get("NAME_EN") or p.get("NAME"), "label": p.get("NAME") or p.get("NAME_EN"),
               "lat": lat, "lon": lon}
        by_iso3[iso3] = rec
        if p.get("ISO_A3") and p["ISO_A3"] != "-99":
            by_iso3.setdefault(p["ISO_A3"], rec)
        if rec["fips"]:
            by_fips[rec["fips"]] = rec
    # GDELT uses a few FIPS codes NE lacks (Gaza Strip, West Bank -> PSE)
    for fips, iso in {"GZ": "PSE", "WE": "PSE", "IS": "ISR", "NO": "NOR", "OD": "SDS", "SO": "SOM"}.items():
        if iso in by_iso3:
            by_fips.setdefault(fips, by_iso3[iso])
    return {"iso3": by_iso3, "fips": by_fips}


def iso3(code: str | None):
    if not code:
        return None
    code = CAMEO_TO_NE.get(code, code)
    rec = table()["iso3"].get(code)
    return rec["iso3"] if rec else None
