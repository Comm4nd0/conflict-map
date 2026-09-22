"""Pull GDELT 2.0 event files (every 15 min) and keep material-conflict events."""
import csv
import io
import logging
import time
import zipfile
from datetime import datetime, timedelta, timezone

import httpx

from .config import GDELT_BACKFILL_HOURS, GDELT_WINDOW_HOURS
from .db import db

log = logging.getLogger("gdelt")
BASE = "https://data.gdeltproject.org/gdeltv2/"


def _stamps(hours: int):
    """Every 15-minute stamp for the last N hours, newest first."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now -= timedelta(minutes=now.minute % 15)
    t = now
    end = now - timedelta(hours=hours)
    while t > end:
        yield t.strftime("%Y%m%d%H%M%S")
        t -= timedelta(minutes=15)


def _parse(stamp: str, raw: bytes):
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = z.namelist()[0]
        text = z.read(name).decode("utf-8", "replace")
    rows = []
    for r in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(r) < 61:
            continue
        try:
            quad = int(r[29])
        except ValueError:
            continue
        if quad != 4:  # material conflict only
            continue
        try:
            lat = float(r[56]) if r[56] else None
            lon = float(r[57]) if r[57] else None
        except ValueError:
            lat = lon = None
        added = datetime.strptime(r[59], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        rows.append((
            int(r[0]), r[1], int(added.timestamp()),
            r[7] or None, r[17] or None,
            int(r[28]), int(r[27]), int(r[26]),
            float(r[30]), int(r[31]), int(r[32]), float(r[34]),
            r[53] or None, r[52] or None, lat, lon, r[60],
        ))
    return rows


def update(max_files: int | None = None):
    with db() as con:
        have = {r[0] for r in con.execute("SELECT stamp FROM gdelt_files")}
    todo = [s for s in _stamps(GDELT_BACKFILL_HOURS) if s not in have]
    if max_files:
        todo = todo[:max_files]
    if not todo:
        return 0
    log.info("fetching %d GDELT files", len(todo))
    n = 0
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        for stamp in todo:
            url = f"{BASE}{stamp}.export.CSV.zip"
            try:
                resp = client.get(url)
            except httpx.HTTPError as e:
                log.warning("%s: %s", stamp, e)
                continue
            if resp.status_code == 404:
                rows = []
            elif resp.status_code != 200:
                log.warning("%s: HTTP %s", stamp, resp.status_code)
                continue
            else:
                try:
                    rows = _parse(stamp, resp.content)
                except Exception as e:  # noqa: BLE001
                    log.warning("%s: parse error %s", stamp, e)
                    continue
            with db() as con:
                con.executemany(
                    "INSERT OR IGNORE INTO gdelt_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
                )
                con.execute("INSERT OR REPLACE INTO gdelt_files VALUES (?,?,?)",
                            (stamp, int(time.time()), len(rows)))
            n += len(rows)
    # prune old
    cutoff = int(time.time()) - max(GDELT_WINDOW_HOURS, GDELT_BACKFILL_HOURS) * 3600 - 3600
    with db() as con:
        con.execute("DELETE FROM gdelt_events WHERE added < ?", (cutoff,))
    log.info("stored %d conflict events", n)
    return n


def aggregate(hours: int = GDELT_WINDOW_HOURS) -> dict:
    """Per-country heat, point cloud for heatmap, and actor-pair arcs."""
    cutoff = int(time.time()) - hours * 3600
    with db() as con:
        countries = {}
        for r in con.execute(
            "SELECT geo_cc, COUNT(*) c, SUM(mentions) m, AVG(goldstein) g FROM gdelt_events "
            "WHERE added>=? AND geo_cc IS NOT NULL AND root IN (19,20) GROUP BY geo_cc", (cutoff,)):
            countries[r["geo_cc"]] = {"events": r["c"], "mentions": r["m"], "goldstein": round(r["g"], 2)}
        points = [
            [round(r["lon"], 3), round(r["lat"], 3), r["mentions"]]
            for r in con.execute(
                "SELECT lat, lon, mentions FROM gdelt_events WHERE added>=? AND lat IS NOT NULL "
                "AND root IN (19,20) ORDER BY mentions DESC LIMIT 4000", (cutoff,))
        ]
        pairs = [
            {"a1": r["a1"], "a2": r["a2"], "mentions": r["m"], "events": r["c"]}
            for r in con.execute(
                "SELECT a1, a2, SUM(mentions) m, COUNT(*) c FROM gdelt_events "
                "WHERE added>=? AND a1 IS NOT NULL AND a2 IS NOT NULL AND a1<>a2 "
                "GROUP BY a1, a2 ORDER BY m DESC LIMIT 40", (cutoff,))
        ]
        # located violent incidents (fight / mass violence) aggregated per place; the most-mentioned row supplies the source
        agg: dict = {}
        for r in con.execute(
            "SELECT geo_name, geo_cc, ROUND(lat,2) la, ROUND(lon,2) lo, mentions, root, day, url FROM gdelt_events "
            "WHERE added>=? AND lat IS NOT NULL AND root IN (19,20) ORDER BY mentions DESC", (cutoff,)):
            k = (r["la"], r["lo"])
            a = agg.get(k)
            if a is None:
                agg[k] = {"name": r["geo_name"], "cc": r["geo_cc"], "lat": r["la"], "lon": r["lo"], "n": 1,
                          "m": r["mentions"], "root": r["root"], "day": r["day"], "url": r["url"], "urls": [r["url"]]}
            else:
                a["n"] += 1
                a["m"] += r["mentions"]
                a["root"] = max(a["root"], r["root"])
                a["day"] = max(a["day"], r["day"])
                if len(a["urls"]) < 3 and r["url"] not in a["urls"]:
                    a["urls"].append(r["url"])
        incidents = sorted(agg.values(), key=lambda a: -a["m"])[:2500]
        total = con.execute("SELECT COUNT(*) FROM gdelt_events WHERE added>=?", (cutoff,)).fetchone()[0]
        latest = con.execute("SELECT MAX(added) FROM gdelt_events").fetchone()[0]
    return {"hours": hours, "total": total, "latest": latest,
            "countries": countries, "points": points, "pairs": pairs, "incidents": incidents}
