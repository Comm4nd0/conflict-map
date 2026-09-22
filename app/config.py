import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
DB_PATH = DATA_DIR / "conflict.db"

LLM_BASE = os.environ.get("LLM_BASE", "http://127.0.0.1:8080/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-oss-120b")
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "900"))

# hours of GDELT history to backfill on first run / keep in aggregations
GDELT_BACKFILL_HOURS = int(os.environ.get("GDELT_BACKFILL_HOURS", "48"))
GDELT_WINDOW_HOURS = int(os.environ.get("GDELT_WINDOW_HOURS", "48"))

REFRESH_MINUTES = int(os.environ.get("REFRESH_MINUTES", "30"))
ARTICLES_PER_BATCH = int(os.environ.get("ARTICLES_PER_BATCH", "40"))

FEEDS = {
    "BBC World": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "Guardian World": "https://www.theguardian.com/world/rss",
    "NYT World": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "DW World": "https://rss.dw.com/rdf/rss-en-world",
    "France 24": "https://www.france24.com/en/rss",
    "UN News": "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    "Kyiv Independent": "https://kyivindependent.com/news-archive/rss/",
    "Times of Israel": "https://www.timesofisrael.com/feed/",
}
