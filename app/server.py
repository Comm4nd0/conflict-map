import asyncio
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import aircraft, countries, ships, gdelt, pipeline, reader
from .config import AIRCRAFT_ENABLED, GDELT_WINDOW_HOURS, REFRESH_MINUTES, SERVE_ONLY, STATIC_DIR
from .db import all_conflicts, db, get_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("server")
app = FastAPI(title="conflict-map")
_lock = threading.Lock()
_agg_cache: dict = {}


def _aggregate_cached(hours: int):
    now = time.time()
    hit = _agg_cache.get(hours)
    if hit and now - hit[0] < 60:
        return hit[1]
    data = gdelt.aggregate(hours)
    _agg_cache[hours] = (now, data)
    return data


def _refresh_job(skip_llm=False):
    if not _lock.acquire(blocking=False):
        return {"busy": True}
    try:
        return pipeline.refresh(skip_llm=skip_llm)
    finally:
        _lock.release()


async def _loop():
    await asyncio.sleep(5)
    while True:
        await asyncio.to_thread(_refresh_job)
        await asyncio.sleep(REFRESH_MINUTES * 60)


@app.on_event("startup")
async def _start():
    if AIRCRAFT_ENABLED:
        threading.Thread(target=aircraft.run_forever, name="aircraft", daemon=True).start()
    threading.Thread(target=ships.run_forever, name="ships", daemon=True).start()
    if SERVE_ONLY:
        log.info("SERVE_ONLY: viewer mode, no pipeline")
        return
    asyncio.create_task(_loop())


@app.get("/healthz")
def healthz():
    with db() as con:
        n = con.execute("SELECT COUNT(*) FROM conflicts").fetchone()[0]
    return {"ok": True, "conflicts": n, "serve_only": SERVE_ONLY}


@app.get("/api/state")
def state(hours: int = GDELT_WINDOW_HOURS, strike_days: int = 7):
    since = (datetime.now(timezone.utc) - timedelta(days=strike_days)).strftime("%Y-%m-%d")
    with db() as con:
        conflicts = all_conflicts(con)
        d7 = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        d14 = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%d")
        activity = {r[0]: {"attacks_7d": r[1], "attacks_prev_7d": r[2]} for r in con.execute(
            "SELECT conflict_id, SUM(date > ?), SUM(date > ? AND date <= ?) FROM strikes GROUP BY conflict_id", (d7, d14, d7))}
        strikes = [dict(r) for r in con.execute(
            "SELECT * FROM strikes WHERE date >= ? ORDER BY date DESC, id DESC LIMIT 600", (since,))]
        meta = {
            "last_refresh": get_state(con, "last_refresh"),
            "last_extract": get_state(con, "last_extract"),
            "unprocessed": con.execute("SELECT COUNT(*) FROM articles WHERE processed=0").fetchone()[0],
            "articles": con.execute("SELECT COUNT(*) FROM articles").fetchone()[0],
            "skipped": con.execute("SELECT COUNT(*) FROM articles WHERE processed=2").fetchone()[0],
            "sources": con.execute("SELECT COUNT(DISTINCT source) FROM articles WHERE published > strftime('%s','now') - 7*86400").fetchone()[0],
            "busy": _lock.locked(),
            "serve_only": SERVE_ONLY,
            "attacks_since": con.execute("SELECT MIN(created) FROM strikes").fetchone()[0],
            "now": int(time.time()),
        }
    agg = _aggregate_cached(hours)
    tbl = countries.table()
    # translate GDELT FIPS -> ISO3 and CAMEO pairs -> ISO3 with centroids
    heat = {}
    for fips, v in agg["countries"].items():
        rec = tbl["fips"].get(fips)
        if rec:
            h = heat.setdefault(rec["iso3"], {"events": 0, "mentions": 0})
            h["events"] += v["events"]
            h["mentions"] += v["mentions"]
    pairs = []
    for p in agg["pairs"]:
        a, b = countries.iso3(p["a1"]), countries.iso3(p["a2"])
        if a and b and a != b:
            pairs.append({"a": a, "b": b, "mentions": p["mentions"], "events": p["events"]})
    incidents = []
    for i in agg["incidents"]:
        rec = tbl["fips"].get(i["cc"])
        incidents.append({**i, "iso3": rec["iso3"] if rec else None})
    for c in conflicts:
        c["activity"] = activity.get(c["id"], {"attacks_7d": 0, "attacks_prev_7d": 0})
    conflicts.sort(key=lambda c: (-(c.get("severity") or 0), -(c.get("last_seen") or 0)))
    return JSONResponse({
        "meta": meta,
        "conflicts": conflicts,
        "strikes": strikes,
        "gdelt": {"hours": agg["hours"], "total": agg["total"], "latest": agg["latest"],
                  "heat": heat, "points": agg["points"], "pairs": pairs, "incidents": incidents},
    })


@app.get("/api/article")
async def article(url: str):
    if len(url) > 2000:
        return JSONResponse({"ok": False, "error": "bad url"}, status_code=400)
    return await asyncio.to_thread(reader.fetch, url)


@app.get("/api/aircraft")
def aircraft_view():
    if not AIRCRAFT_ENABLED:
        return {"enabled": False, "aircraft": []}
    return {"enabled": True, **aircraft.tracker.view()}


@app.get("/api/ships")
def ships_view():
    return ships.fleet.view()


@app.get("/api/countries")
def country_table():
    return countries.table()["iso3"]


@app.post("/api/refresh")
async def refresh(skip_llm: bool = False):
    if SERVE_ONLY:
        return JSONResponse({"error": "viewer mode: refreshes run on the home pipeline"}, status_code=403)
    asyncio.create_task(asyncio.to_thread(_refresh_job, skip_llm))
    return {"started": not _lock.locked()}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
