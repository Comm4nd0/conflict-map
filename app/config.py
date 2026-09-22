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

# SERVE_ONLY=1: read-only viewer (no GDELT/feeds/LLM), used on the public server.
SERVE_ONLY = os.environ.get("SERVE_ONLY", "0") == "1"
# After each refresh, copy the database to this scp target (e.g. "luma:/root/conflict-map/data"). Empty = off.
PUSH_TARGET = os.environ.get("PUSH_TARGET", "")
ARTICLES_PER_BATCH = int(os.environ.get("ARTICLES_PER_BATCH", "40"))

FEEDS = {
    # wires / global
    "BBC World": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "BBC Middle East": "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
    "BBC Africa": "https://feeds.bbci.co.uk/news/world/africa/rss.xml",
    "BBC Europe": "https://feeds.bbci.co.uk/news/world/europe/rss.xml",
    "BBC Asia": "https://feeds.bbci.co.uk/news/world/asia/rss.xml",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "Guardian World": "https://www.theguardian.com/world/rss",
    "Guardian Ukraine": "https://www.theguardian.com/world/ukraine/rss",
    "Guardian Middle East": "https://www.theguardian.com/world/middleeast/rss",
    "Guardian Africa": "https://www.theguardian.com/world/africa/rss",
    "NYT World": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "Washington Post World": "https://feeds.washingtonpost.com/rss/world",
    "CNN World": "http://rss.cnn.com/rss/edition_world.rss",
    "NPR World": "https://feeds.npr.org/1004/rss.xml",
    "CBC World": "https://www.cbc.ca/webfeed/rss/rss-world",
    "Sky News World": "https://feeds.skynews.com/feeds/rss/world.xml",
    "Independent World": "https://www.independent.co.uk/news/world/rss",
    "DW World": "https://rss.dw.com/rdf/rss-en-world",
    "DW Top": "https://rss.dw.com/rdf/rss-en-top",
    "France 24": "https://www.france24.com/en/rss",
    "France 24 Africa": "https://www.france24.com/en/africa/rss",
    "France 24 Middle East": "https://www.france24.com/en/middle-east/rss",
    "France 24 Europe": "https://www.france24.com/en/europe/rss",
    "France 24 Asia": "https://www.france24.com/en/asia-pacific/rss",
    "Euronews": "https://www.euronews.com/rss",
    "Politico Europe": "https://www.politico.eu/feed/",
    "Voice of America": "https://www.voanews.com/api/zq$omekvi_",
    "UN News": "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    "ReliefWeb": "https://reliefweb.int/updates/rss.xml",
    # Google News keyword feeds (aggregate many outlets incl. Reuters/AP)
    "Google News: conflict": "https://news.google.com/rss/search?q=airstrike+OR+missile+OR+%22drone+attack%22+OR+offensive+OR+ceasefire&hl=en-US&gl=US&ceid=US:en",
    "Google News: Reuters": "https://news.google.com/rss/search?q=site:reuters.com+(war+OR+strikes+OR+attack)&hl=en-US&gl=US&ceid=US:en",
    "Google News: AP": "https://news.google.com/rss/search?q=site:apnews.com+(war+OR+strikes+OR+attack)&hl=en-US&gl=US&ceid=US:en",
    # regional
    "Kyiv Independent": "https://kyivindependent.com/news-archive/rss/",
    "Ukrainska Pravda": "https://www.pravda.com.ua/eng/rss/",
    "TASS": "https://tass.com/rss/v2.xml",
    "Times of Israel": "https://www.timesofisrael.com/feed/",
    "Jerusalem Post": "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
    "Haaretz": "https://www.haaretz.com/srv/haaretz-latest-headlines",
    "Middle East Eye": "https://www.middleeasteye.net/rss",
    "Al-Monitor": "https://www.al-monitor.com/rss",
    "Anadolu": "https://www.aa.com.tr/en/rss/default?cat=world",
    "Africanews": "https://www.africanews.com/feed/rss",
    "AllAfrica": "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
    "Dawn": "https://www.dawn.com/feeds/home",
    "The Hindu International": "https://www.thehindu.com/news/international/feeder/default.rss",
    "Times of India World": "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
    "SCMP World": "https://www.scmp.com/rss/91/feed",
    "Japan Times": "https://www.japantimes.co.jp/feed/",
    "Yonhap": "https://en.yna.co.kr/RSS/news.xml",
    "The Diplomat": "https://thediplomat.com/feed/",
    # defence / analysis
    "Defense One": "https://www.defenseone.com/rss/all/",
    "Breaking Defense": "https://breakingdefense.com/feed/",
    "The War Zone": "https://www.twz.com/feed",
    "War on the Rocks": "https://warontherocks.com/feed/",
    "Long War Journal": "https://www.longwarjournal.org/feed",
    "Crisis Group": "https://www.crisisgroup.org/rss",
    "Bellingcat": "https://www.bellingcat.com/feed/",
}

# Articles whose title+summary match none of these never reach the LLM (processed=2).
RELEVANCE_TERMS = [
    "war", "strike", "airstrike", "missile", "drone", "attack", "troops", "military", "army", "rebel",
    "militant", "insurgen", "ceasefire", "offensive", "shelling", "artillery", "bomb", "killed", "clash",
    "fighting", "forces", "soldier", "navy", "naval", "warship", "jets", "occupied", "occupation",
    "front line", "frontline", "siege", "coup", "hostage", "terror", "jihad", "militia", "mercenar",
    "sanction", "refugee", "displaced", "humanitarian", "famine", "blockade", "invasion", "invade",
    "conflict", "combat", "weapon", "nuclear", "hezbollah", "hamas", "houthi", "taliban", "isis",
    "islamic state", "wagner", "kremlin", "nato", "idf", "peacekeep", "junta", "armed", "casualt",
    "massacre", "genocide", "gaza", "ukraine", "sudan", "yemen", "myanmar", "sahel", "congo", "somalia",
]
