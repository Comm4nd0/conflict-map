"""Fetch RSS feeds into the articles table."""
import calendar
import logging
import re
import time
from html import unescape

import feedparser
import httpx

from .config import FEEDS
from .db import db

log = logging.getLogger("feeds")
TAG = re.compile(r"<[^>]+>")


def _clean(s: str, limit: int = 600) -> str:
    s = unescape(TAG.sub(" ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def update() -> int:
    new = 0
    with httpx.Client(timeout=30, follow_redirects=True,
                      headers={"User-Agent": "conflict-map/0.1 (local)"}) as client:
        for name, url in FEEDS.items():
            try:
                resp = client.get(url)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                log.warning("%s: %s", name, e)
                continue
            parsed = feedparser.parse(resp.content)
            rows = []
            for e in parsed.entries:
                link = e.get("link")
                if not link:
                    continue
                pub = e.get("published_parsed") or e.get("updated_parsed")
                ts = calendar.timegm(pub) if pub else int(time.time())
                rows.append((link, name, _clean(e.get("title", ""), 300),
                             _clean(e.get("summary", "")), ts, int(time.time())))
            with db() as con:
                before = con.total_changes
                con.executemany(
                    "INSERT OR IGNORE INTO articles(link,source,title,summary,published,fetched) "
                    "VALUES (?,?,?,?,?,?)", rows)
                added = con.total_changes - before
            new += added
            log.info("%s: %d entries, %d new", name, len(rows), added)
    return new
