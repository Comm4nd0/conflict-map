import asyncio
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import countries, gdelt, pipeline
from .config import GDELT_WINDOW_HOURS, REFRESH_MINUTES, STATIC_DIR
from .db import all_conflicts, db, get_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("server")
app = FastAPI(title="conflict-map")
_lock = threading.Lock()


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
    asyncio.create_task(_loop())


@app.get("/api/state")
def state(hours: int = GDELT_WINDOW_HOURS, strike_days: int = 7):
    since = (datetime.now(timezone.utc) - timedelta(days=strike_days)).strftime("%Y-%m-%d")
    with db() as con:
        conflicts = all_conflicts(con)
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
            "now": int(time.time()),
        }
    agg = gdelt.aggregate(hours)
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
    conflicts.sort(key=lambda c: (-(c.get("severity") or 0), -(c.get("last_seen") or 0)))
    return JSONResponse({
        "meta": meta,
        "conflicts": conflicts,
        "strikes": strikes,
        "gdelt": {"hours": agg["hours"], "total": agg["total"], "latest": agg["latest"],
                  "heat": heat, "points": agg["points"], "pairs": pairs},
    })


@app.get("/api/countries")
def country_table():
    return countries.table()["iso3"]


@app.post("/api/refresh")
async def refresh(skip_llm: bool = False):
    asyncio.create_task(asyncio.to_thread(_refresh_job, skip_llm))
    return {"started": not _lock.locked()}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
