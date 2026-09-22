"""Run one full refresh: GDELT + feeds + LLM extraction."""
import logging
import sqlite3
import subprocess
import time

from . import extract, feeds, gdelt
from .config import DATA_DIR, DB_PATH, PUSH_TARGET
from .db import db, set_state

log = logging.getLogger("pipeline")


def refresh(skip_llm: bool = False, gdelt_files: int | None = None):
    t0 = time.time()
    stats = {"started": int(t0)}
    try:
        stats["gdelt_events"] = gdelt.update(max_files=gdelt_files)
    except Exception as e:  # noqa: BLE001
        log.exception("gdelt failed")
        stats["gdelt_error"] = str(e)
    try:
        stats["new_articles"] = feeds.update()
    except Exception as e:  # noqa: BLE001
        log.exception("feeds failed")
        stats["feeds_error"] = str(e)
    if not skip_llm:
        try:
            stats["conflicts_updated"] = extract.run_all()
        except Exception as e:  # noqa: BLE001
            log.exception("extract failed")
            stats["extract_error"] = str(e)
    stats["secs"] = round(time.time() - t0)
    with db() as con:
        set_state(con, "last_refresh", stats)
    if PUSH_TARGET:
        try:
            push_db(PUSH_TARGET)
            stats["pushed"] = PUSH_TARGET
        except Exception as e:  # noqa: BLE001
            log.exception("push failed")
            stats["push_error"] = str(e)
    log.info("refresh done: %s", stats)
    return stats


def push_db(target: str):
    """WAL-safe snapshot of the database, converted to a single file, copied to the
    viewer with scp and swapped in atomically (mv on the remote side)."""
    snap = DATA_DIR / "conflict.snapshot.db"
    if snap.exists():
        snap.unlink()
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(snap)
    src.backup(dst)
    dst.execute("PRAGMA journal_mode=DELETE")
    dst.execute("VACUUM")
    dst.close()
    src.close()
    host, _, remote_dir = target.partition(":")
    subprocess.run(["scp", "-q", str(snap), f"{host}:{remote_dir}/conflict.db.tmp"], check=True, timeout=300)
    subprocess.run(["ssh", host, f"mv -f {remote_dir}/conflict.db.tmp {remote_dir}/conflict.db"], check=True, timeout=60)
    log.info("pushed %.1f MB to %s", snap.stat().st_size / 1e6, target)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-llm", action="store_true")
    ap.add_argument("--gdelt-files", type=int, default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    refresh(skip_llm=a.skip_llm, gdelt_files=a.gdelt_files)
