"""Reader view: fetch an article and return its readable text (server side, cached, SSRF-guarded)."""
import ipaddress
import logging
import re
import socket
import threading
import time
from urllib.parse import urlparse

import httpx
import trafilatura

log = logging.getLogger("reader")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
MAX_BYTES = 3_000_000
CACHE_TTL = 6 * 3600
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _safe_url(url: str) -> str | None:
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    if u.port not in (None, 80, 443):
        return None
    try:
        infos = socket.getaddrinfo(u.hostname, None)
    except socket.gaierror:
        return None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return None
    return url


def _decode_google_news(url: str) -> str:
    if "news.google.com" not in url:
        return url
    try:
        from googlenewsdecoder import gnewsdecoder
        r = gnewsdecoder(url, interval=1)
        if r.get("status") and r.get("decoded_url"):
            return r["decoded_url"]
    except Exception as e:  # noqa: BLE001
        log.info("google news decode failed: %s", e)
    return url


def _feed_fallback(url: str, result: dict) -> dict:
    """When the page can't be read (consent walls, paywalls), fall back to the feed's own title + summary."""
    try:
        from .db import db
        with db() as con:
            row = con.execute("SELECT title, summary, source, published FROM articles WHERE link=?", (url,)).fetchone()
    except Exception:  # noqa: BLE001
        row = None
    if not row or not (row["summary"] or row["title"]):
        return result
    return {"ok": True, "url": url, "final_url": result.get("final_url") or url, "site": row["source"],
            "title": row["title"], "date": time.strftime("%Y-%m-%d", time.gmtime(row["published"])),
            "paragraphs": [row["summary"] or row["title"]],
            "note": f"Full text unavailable ({result.get('error', 'blocked')}); showing the feed summary."}


def fetch(url: str) -> dict:
    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    result = _fetch(url)
    if not result.get("ok"):
        result = _feed_fallback(url, result)
    with _lock:
        if len(_cache) > 400:
            oldest = sorted(_cache.items(), key=lambda kv: kv[1][0])[:100]
            for k, _ in oldest:
                _cache.pop(k, None)
        _cache[url] = (time.time(), result)
    return result


def _fetch(url: str) -> dict:
    target = _decode_google_news(url)
    safe = _safe_url(target)
    if not safe:
        return {"ok": False, "url": url, "error": "blocked or unresolvable URL"}
    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers={"User-Agent": UA, "Accept-Language": "en"}) as client:
            with client.stream("GET", safe) as resp:
                final = str(resp.url)
                if not _safe_url(final):
                    return {"ok": False, "url": url, "error": "redirect blocked"}
                ctype = resp.headers.get("content-type", "")
                if resp.status_code >= 400:
                    return {"ok": False, "url": url, "final_url": final, "error": f"HTTP {resp.status_code}"}
                if "html" not in ctype and "xml" not in ctype:
                    return {"ok": False, "url": url, "final_url": final, "error": f"not an article ({ctype.split(';')[0]})"}
                buf = bytearray()
                for chunk in resp.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_BYTES:
                        break
                html = bytes(buf).decode(resp.encoding or "utf-8", "replace")
    except httpx.HTTPError as e:
        return {"ok": False, "url": url, "error": f"fetch failed: {e.__class__.__name__}"}
    if "consent.google." in final or "consent.yahoo." in final:
        return {"ok": False, "url": url, "final_url": final, "error": "consent wall"}
    doc = trafilatura.bare_extraction(html, url=final, with_metadata=True, include_comments=False, favor_precision=True)
    d = doc.as_dict() if hasattr(doc, "as_dict") else (doc or {})
    text = (d.get("text") or "").strip()
    if (d.get("title") or "").lower().startswith("before you continue"):
        return {"ok": False, "url": url, "final_url": final, "error": "consent wall"}
    if not text or len(text) < 200:
        return {"ok": False, "url": url, "final_url": final, "title": d.get("title"), "error": "no readable text (paywall or consent page)"}
    paras = [p.strip() for p in re.split(r"\n{1,}", text) if p.strip()]
    host = urlparse(final).hostname or ""
    return {
        "ok": True, "url": url, "final_url": final, "site": d.get("sitename") or host.replace("www.", ""),
        "title": d.get("title"), "byline": d.get("author"), "date": d.get("date"), "image": d.get("image"),
        "description": d.get("description"), "paragraphs": paras[:80],
    }
