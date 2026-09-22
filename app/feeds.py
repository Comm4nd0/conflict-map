"""Fetch RSS feeds into the articles table."""
import calendar
import concurrent.futures as cf
import logging
import re
import time
from html import unescape

import feedparser
import httpx

from .config import FEEDS, RELEVANCE_TERMS
from .db import db

log = logging.getLogger("feeds")
TAG = re.compile(r"<[^>]+>")


def _clean(s: str, limit: int = 600) -> str:
    s = unescape(TAG.sub(" ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


RELEVANT = re.compile("|".join(re.escape(t) for t in RELEVANCE_TERMS), re.I)


def _fetch(name_url):
    name, url = name_url
    try:
        resp = httpx.get(url, timeout=30, follow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0 conflict-map/0.1 (local)"})
        resp.raise_for_status()
    except httpx.HTTPError as e:
        log.warning("%s: %s", name, e)
        return name, []
    parsed = feedparser.parse(resp.content)
    rows = []
    for e in parsed.entries:
        link = e.get("link")
        if not link:
            continue
        pub = e.get("published_parsed") or e.get("updated_parsed")
        ts = calendar.timegm(pub) if pub else int(time.time())
        title = _clean(e.get("title", ""), 300)
        summary = _clean(e.get("summary", ""))
        relevant = bool(RELEVANT.search(title + " " + summary))
        rows.append((link, name, title, summary, ts, int(time.time()), 0 if relevant else 2))
    return name, rows


def update() -> int:
    new = 0
    with cf.ThreadPoolExecutor(8) as ex:
        for name, rows in ex.map(_fetch, FEEDS.items()):
            if not rows:
                continue
            with db() as con:
                before = con.total_changes
                con.executemany(
                    "INSERT OR IGNORE INTO articles(link,source,title,summary,published,fetched,processed) "
                    "VALUES (?,?,?,?,?,?,?)", rows)
                added = con.total_changes - before
            new += added
            log.info("%s: %d entries, %d new, %d relevant", name, len(rows), added, sum(1 for r in rows if r[6] == 0))
    return new
