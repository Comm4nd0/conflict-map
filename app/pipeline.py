"""Run one full refresh: GDELT + feeds + LLM extraction."""
import logging
import time

from . import extract, feeds, gdelt
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
    log.info("refresh done: %s", stats)
    return stats


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-llm", action="store_true")
    ap.add_argument("--gdelt-files", type=int, default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    refresh(skip_llm=a.skip_llm, gdelt_files=a.gdelt_files)
