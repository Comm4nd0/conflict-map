"""Headline figures per conflict (start date, deaths, displacement ...), extracted from recent
articles by the local model. Every number must cite an article and say who reported it; only
the start date may come from background knowledge, and it is labelled as such."""
import json
import logging
import re
import time
from datetime import datetime, timezone

from . import extract, reader
from .db import all_conflicts, db, upsert_conflict

log = logging.getLogger("stats")
KEYS = ["killed", "casualties", "killed_civilians", "wounded", "displaced", "refugees", "in_need", "hostages", "missing"]
SIDES = ["A", "B", "total", "civilians"]
REFRESH_HOURS = 12

PROMPT = """You extract HEADLINE FIGURES for one armed conflict from news items. Return ONLY compact JSON:
{"started": {"date": "YYYY-MM-DD or YYYY-MM or YYYY", "event": "what began it, <= 8 words", "basis": "article" | "background"},
 "figures": [{"key": one of %s, "side": one of %s, "value": integer, "low": integer or null, "high": integer or null,
              "period": "since_start" | "short phrase for any shorter period, e.g. 'August 2026', 'past 24 hours', 'single attack'",
              "quote": "the exact sentence from the item that states the number, copied verbatim",
              "as_of": "YYYY-MM-DD", "claimant_is_party": true | false, "reported_by": "who counts it (e.g. 'UN OHCHR', 'Gaza Health Ministry', 'Ukrainian officials')",
              "article_id": integer}]}
Rules:
- A figure MUST be stated in the given news items and cite its article_id. Never estimate, add up, or use memory for figures.
- Prefer conflict-wide totals ("more than 65,000 killed since October 2023"): period "since_start". A monthly report, a daily update or a single attack is NOT since_start; give its period.
- "casualties" = killed AND wounded combined (e.g. Ukraine's General Staff "personnel losses" of Russian forces). Never put a combined figure under "killed".
- claimant_is_party = true when the number comes from one of the warring sides about the other (e.g. Ukraine's count of Russian losses).
- side: "A"/"B" = losses of that side's forces/people, "civilians" = civilian toll, "total" = all people.
- The start date may use well-established background knowledge (basis "background") if no article states it.
- Omit anything not supported. Empty figures list is fine.
Conflict: %s
Sides: %s
Today: %s"""


def _related_articles(c: dict, con, days: int = 21, limit: int = 60) -> list:
    terms = sorted(extract._conflict_terms(c), key=len, reverse=True)[:12]
    if not terms:
        return []
    cutoff = int(time.time()) - days * 86400
    like = " OR ".join(["(title || ' ' || summary) LIKE ?"] * len(terms))
    num = "(title || ' ' || summary) GLOB '*[0-9][0-9][0-9]*'"            # figures need numbers
    rows = con.execute(
        f"SELECT id, link, source, title, summary, published FROM articles WHERE published >= ? AND ({like}) AND {num} "
        "ORDER BY published DESC LIMIT ?", [cutoff, *[f"%{t}%" for t in terms], limit]).fetchall()
    return [dict(r) for r in rows]


TOLL = re.compile(r"\b(killed|dead|deaths?|death toll|casualt|wounded|injured|displaced|refugees?|fled|hostages?|"
                  r"missing|famine|in need|humanitarian aid|civilians)\b", re.I)
NUM = re.compile(r"\d[\d,.]{2,}|\b\d+(\.\d+)?\s*(million|thousand)\b|\b(hundreds|thousands|tens of thousands)\b", re.I)


def _toll_paragraphs(text_paras: list[str], limit: int = 6) -> list[str]:
    keep = [p for p in text_paras if TOLL.search(p) and NUM.search(p)]
    return [p[:600] for p in keep[:limit]]


def refresh_one(c: dict, max_fetch: int = 10) -> dict | None:
    with db() as con:
        rows = _related_articles(c, con)
    if not rows:
        return None
    # read the full text of the most toll-relevant articles: headline totals live in the body, not the feed summary
    ranked = sorted(rows, key=lambda r: (bool(TOLL.search(r["title"] + " " + r["summary"])), r["published"]), reverse=True)
    for r in ranked[:max_fetch]:
        try:
            a = reader.fetch(r["link"])
        except Exception:  # noqa: BLE001
            continue
        if a.get("ok") and not a.get("note"):
            r["body"] = _toll_paragraphs(a.get("paragraphs") or [])
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sides = "; ".join(f"{p.get('side')}: {p.get('name')}" for p in c.get("parties", []) if p.get("role") == "combatant")
    items = "\n".join(
        f"[{r['id']}] ({r['source']}, {datetime.fromtimestamp(r['published'], timezone.utc):%Y-%m-%d}) {r['title']} — {r['summary']}"
        + ("".join(f"\n    > {p}" for p in r.get("body") or []))
        for r in rows)
    text = extract.call_llm([
        {"role": "system", "content": PROMPT % (KEYS, SIDES, c.get("name"), sides, today)},
        {"role": "user", "content": items},
    ])
    try:
        res = extract._parse_json(text)
    except Exception:  # noqa: BLE001
        log.warning("stats: bad JSON for %s", c["id"])
        return None
    art = {r["id"]: r for r in rows}
    figs = []
    for f in res.get("figures") or []:
        a = art.get(f.get("article_id"))
        if f.get("key") not in KEYS or f.get("side") not in SIDES or not isinstance(f.get("value"), int) or not a:
            continue
        if not extract._cites_ok(c, a) or f["value"] <= 0:
            continue
        # the number must actually appear in the cited text (in some form)
        text_a = " ".join([a["title"], a["summary"], *(a.get("body") or [])]).replace(",", "").replace("\u202f", "").replace("\u00a0", " ")
        v = f["value"]
        forms = {str(v)} | ({f"{v/1e6:g} million", f"{v/1e6:g}m"} if v >= 1_000_000 else set()) | ({f"{v/1000:g}000", f"{v//1000}000"} if v >= 1000 else set())
        if not any(x.lower() in text_a.lower() for x in forms) and not re.search(rf"\b{v/1e6:g}\s*(million|m)\b", text_a, re.I):
            log.info("stats: %s %s=%s not found in cited text, dropped", c["id"], f["key"], v)
            continue
        # the quote must really be in the article (readers see it, so it must not be paraphrased or invented)
        quote = re.sub(r"\s+", " ", (f.get("quote") or "")).strip()
        qw = set(re.findall(r"[a-z0-9]{3,}", quote.lower().replace(",", "").replace("\u202f", "")))
        tw = set(re.findall(r"[a-z0-9]{3,}", text_a.lower()))
        if not quote or len(qw & tw) < 0.85 * max(1, len(qw)):
            log.info("stats: %s quote not found in article, dropped: %.80s", c["id"], quote)
            continue
        figs.append({"key": f["key"], "side": f["side"], "value": v, "low": f.get("low"), "high": f.get("high"),
                     "period": (str(f.get("period") or "since_start"))[:40],
                     "cumulative": str(f.get("period") or "since_start") == "since_start",
                     "claimant_is_party": bool(f.get("claimant_is_party")), "as_of": str(f.get("as_of") or "")[:10],
                     "reported_by": (f.get("reported_by") or a["source"])[:80],
                     "quote": quote[:300], "link": a["link"], "title": a["title"], "source": a["source"]})
    st = res.get("started") or {}
    started = None
    if re.match(r"^\d{4}(-\d{2}){0,2}$", str(st.get("date") or "")):
        started = {"date": st["date"], "event": (st.get("event") or "")[:80], "basis": "article" if st.get("basis") == "article" else "background"}
    return {"started": started, "figures": figs}


def merge(old: dict | None, new: dict) -> dict:
    """Keep the newest cumulative figure per (key, side); a new run never wipes older sourced numbers."""
    best = {}
    for f in (old or {}).get("figures", []) + new.get("figures", []):
        k = (f["key"], f["side"], bool(f.get("cumulative", True)))
        cur = best.get(k)
        if cur is None or (f.get("as_of") or "") > (cur.get("as_of") or "") or \
           ((f.get("as_of") or "") == (cur.get("as_of") or "") and f["value"] > cur["value"]):
            best[k] = f
    started = new.get("started") or (old or {}).get("started")
    if (old or {}).get("started", {}) and (old["started"].get("basis") == "article") and (new.get("started") or {}).get("basis") != "article":
        started = old["started"]
    return {"started": started, "figures": sorted(best.values(), key=lambda f: (not f.get("cumulative", True), KEYS.index(f["key"]), SIDES.index(f["side"]))),
            "updated": int(time.time())}


def refresh(max_conflicts: int = 4, force: bool = False) -> int:
    with db() as con:
        conflicts = all_conflicts(con)
    due = [c for c in conflicts if force or time.time() - (c.get("stats") or {}).get("updated", 0) > REFRESH_HOURS * 3600]
    due.sort(key=lambda c: ((c.get("stats") or {}).get("updated", 0), -(c.get("severity") or 0)))
    n = 0
    for c in due[:max_conflicts]:
        t0 = time.time()
        new = refresh_one(c)
        if new is None:
            continue
        with db() as con:
            fresh = next((x for x in all_conflicts(con) if x["id"] == c["id"]), None)
            if not fresh:
                continue
            fresh["stats"] = merge(fresh.get("stats"), new)
            cid = fresh.pop("id"); fresh.pop("created", None); fresh.pop("updated", None)
            upsert_conflict(con, cid, fresh)
        n += 1
        log.info("stats %s: %d figures, started=%s (%.0fs)", c["id"], len(fresh["stats"]["figures"]), (fresh["stats"].get("started") or {}).get("date"), time.time() - t0)
    return n
