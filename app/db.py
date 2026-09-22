import json
import sqlite3
import time
from contextlib import contextmanager

from .config import DATA_DIR, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS gdelt_events (
    id INTEGER PRIMARY KEY,
    day TEXT,
    added INTEGER,          -- DATEADDED as unix seconds
    a1 TEXT, a2 TEXT,       -- CAMEO country codes
    root INTEGER, base INTEGER, code INTEGER,
    goldstein REAL, mentions INTEGER, sources INTEGER, tone REAL,
    geo_cc TEXT,            -- FIPS 10-4 country code of action
    geo_name TEXT,
    lat REAL, lon REAL,
    url TEXT
);
CREATE INDEX IF NOT EXISTS idx_gdelt_added ON gdelt_events(added);
CREATE TABLE IF NOT EXISTS gdelt_files (
    stamp TEXT PRIMARY KEY, fetched INTEGER, rows INTEGER
);
CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link TEXT UNIQUE,
    source TEXT, title TEXT, summary TEXT,
    published INTEGER, fetched INTEGER,
    processed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_articles_processed ON articles(processed, published);
CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,     -- JSON blob
    created INTEGER, updated INTEGER
);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


@contextmanager
def db():
    con = connect()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def set_state(con, key, value):
    con.execute("INSERT OR REPLACE INTO state(key,value) VALUES(?,?)", (key, json.dumps(value)))


def get_state(con, key, default=None):
    row = con.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def upsert_conflict(con, cid: str, data: dict):
    now = int(time.time())
    row = con.execute("SELECT created FROM conflicts WHERE id=?", (cid,)).fetchone()
    created = row[0] if row else now
    con.execute(
        "INSERT OR REPLACE INTO conflicts(id,data,created,updated) VALUES(?,?,?,?)",
        (cid, json.dumps(data), created, now),
    )


def all_conflicts(con) -> list[dict]:
    out = []
    for r in con.execute("SELECT id,data,created,updated FROM conflicts"):
        d = json.loads(r["data"])
        d["id"] = r["id"]
        d["created"] = r["created"]
        d["updated"] = r["updated"]
        out.append(d)
    return out
