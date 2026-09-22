"""Turn unprocessed articles into structured conflict records via the local LLM."""
import json
import logging
import re
import time
from datetime import datetime, timezone

import httpx

from . import geo
from .config import ARTICLES_PER_BATCH, LLM_BASE, LLM_MODEL, LLM_TIMEOUT
from .db import all_conflicts, db, set_state, upsert_conflict

log = logging.getLogger("extract")

CONSEQUENCE_CATEGORIES = [
    "casualties", "displacement", "humanitarian", "sanctions", "energy",
    "food", "shipping", "economy", "diplomacy", "military", "nuclear", "cyber", "other",
]

SYSTEM = f"""You are an analyst maintaining a structured database of CURRENT ARMED CONFLICTS and interstate military crises for a world-map visualisation.

You receive (1) the existing conflict records and (2) a batch of new news items with numeric ids.
Return ONLY a JSON object: {{"conflicts": [...]}} containing every existing conflict that the new items update, plus any genuinely new armed conflict the items reveal. Do not return conflicts the batch says nothing about. Return an empty list if nothing is relevant.

INCLUDE: wars, insurgencies, civil wars, cross-border strikes, military occupations, naval/air confrontations, coups with fighting, terrorist campaigns by armed groups, active ceasefire negotiations for such conflicts.
EXCLUDE: ordinary crime, domestic politics, elections, protests without armed fighting, disasters, sport, business, and purely diplomatic or trade disputes with no fighting or credible military threat (a "standoff" settled by an agreement is NOT an armed conflict).

Each conflict object:
{{
  "id": "kebab-case-stable-id (reuse the existing id when updating; e.g. russia-ukraine, israel-gaza, sudan-civil-war)",
  "name": "short display name",
  "region": "short region label",
  "status": "active" | "escalating" | "de-escalating" | "ceasefire" | "frozen",
  "severity": 1-5 (5 = full-scale war with mass casualties),
  "summary": "2-3 sentence neutral summary of the conflict and where it stands now",
  "epicenter": {{"lat": float, "lon": float, "label": "place"}},
  "parties": [
    {{"name": "Country or armed group", "country": "ISO3 code or null for non-state actors",
      "side": "A" | "B" | "other", "role": "combatant" | "supporter" | "mediator" | "target",
      "note": "one short phrase, e.g. 'supplies drones', 'hosting talks'"}}
  ],
  "consequences": [
    {{"category": one of {CONSEQUENCE_CATEGORIES}, "text": "one concise factual sentence", "affects": ["ISO3", ...] }}
  ],
  "developments": [
    {{"date": "YYYY-MM-DD", "text": "one sentence", "article_ids": [integer ids from this batch, always cite at least one]}}
  ],
  "strikes": [
    {{"date": "YYYY-MM-DD",
      "weapon": "missile" | "drone" | "airstrike" | "artillery" | "shelling" | "ground" | "bombing" | "naval" | "other",
      "attacker": "party that carried it out (e.g. 'RSF', 'IDF', 'Russia', 'M23', 'unknown')",
      "origin": {{"place": "launch area or null if unknown / same area", "country": "ISO3 or null", "lat": float or null, "lon": float or null}},
      "target": {{"place": "city / town / facility name", "country": "ISO3", "lat": float, "lon": float}},
      "launched": integer or null, "intercepted": integer or null,
      "outcome": "short phrase: what was hit / casualties", "article_ids": [integer ids]}}
  ]
}}

Rules:
- Parties: list the direct combatants first. A "supporter" must provide material support to one side (arms, money, troops, bases, intelligence). A country that merely comments, sanctions, hosts talks or denies a visa is NOT a supporter; use "mediator" only for active negotiation hosts. Include supporters when the news or well-established public knowledge supports it (e.g. USA/EU states arming Ukraine, Iran arming the Houthis). Use ISO 3166-1 alpha-3 codes (e.g. UKR, RUS, ISR, PSE, IRN, USA, GBR, SDN, YEM, COD). Non-state actors get "country": null but still belong to a side.
- Keep records COMPLETE on every update: return the full merged party list, the full consequence list (keep prior items still true, add new ones, drop stale ones), and the 6 most recent developments (prior ones plus new ones).
- Be factual and neutral. Cite the article ids that support each development. Never invent developments not in the batch.
- Strikes = ANY located attack reported in THIS batch (never from memory): airstrikes, missiles, drones, artillery/shelling, ground assaults on towns, bombings/IEDs, naval attacks, massacres. This explicitly includes INTERNAL conflicts (RSF shelling El Fasher, IDF strikes on Gaza City, M23 taking Goma, Al-Qaeda attacking a Malian base) - the target is the place hit, the attacker is the party, and origin may be null. One entry per named target place per attack; if an article lists several places hit, emit one entry per place. If the target is only given as a region, put that in "place" and set lat/lon to your best estimate. For cross-border launches give the origin region ("Crimea", "Iran") with ISO3 and rough lat/lon. Use exact numbers from the article for launched/intercepted, else null. Omit "strikes" only if the batch reports no attacks for that conflict.
- Dates: use the article's date. Today is {{today}}.
- Output valid JSON only, no markdown fences, no commentary. Use COMPACT JSON (no indentation or line breaks) - the output must stay short."""


def _compact_existing(conflicts: list[dict]) -> list[dict]:
    out = []
    for c in conflicts:
        out.append({
            "id": c["id"], "name": c.get("name"), "region": c.get("region"),
            "status": c.get("status"), "severity": c.get("severity"),
            "summary": c.get("summary"), "epicenter": c.get("epicenter"),
            "parties": c.get("parties", []),
            "consequences": c.get("consequences", []),
            "developments": [
                {"date": d.get("date"), "text": d.get("text")} for d in c.get("developments", [])[:6]
            ],
        })
    return out


def _repair_json(text: str) -> str:
    """Drop mismatched closing brackets and close anything left open (models
    occasionally emit `}}]}` where `}]}` was meant, or stop mid-way)."""
    out, stack, in_str, esc = [], [], False, False
    pairs = {"{": "}", "[": "]"}
    for ch in text:
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in pairs:
            stack.append(pairs[ch])
        elif ch in "}]":
            if stack and stack[-1] == ch:
                stack.pop()
            else:
                continue  # stray closer: skip it
        out.append(ch)
    if in_str:
        out.append('"')
    # strip a dangling comma before closing what is still open
    while out and out[-1] in ", \n\t":
        out.pop()
    out.extend(reversed(stack))
    return "".join(out)


def _parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    try:
        return json.loads(_repair_json(text))
    except json.JSONDecodeError:
        pass
    # last resort: cut back to the previous closing brace, repair, retry
    t = text
    for _ in range(200):
        i = max(t.rfind("}"), t.rfind("]"), t.rfind(","))
        if i <= 0:
            break
        t = t[:i] if t[i] == "," else t[:i + 1]
        try:
            return json.loads(_repair_json(t))
        except json.JSONDecodeError:
            t = t[:i]
    raise ValueError("model output could not be parsed as JSON")


def call_llm(messages: list[dict]) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 16000,
        "chat_template_kwargs": {"reasoning_effort": "low"},
    }
    with httpx.Client(timeout=LLM_TIMEOUT) as client:
        r = client.post(f"{LLM_BASE}/chat/completions", json=payload)
        r.raise_for_status()
        data = r.json()
    msg = data["choices"][0]["message"]
    usage = data.get("usage", {})
    log.info("llm: %s prompt / %s completion tokens", usage.get("prompt_tokens"), usage.get("completion_tokens"))
    return msg.get("content") or ""


def _valid(c: dict) -> bool:
    return bool(c.get("id")) and bool(c.get("name")) and isinstance(c.get("parties"), list)


WEAPONS = {"missile", "drone", "airstrike", "artillery", "shelling", "ground", "bombing", "naval", "other"}


def _store_strikes(con, conflict_id: str, strikes: list, art: dict) -> int:
    n = 0
    for st in strikes:
        if not isinstance(st, dict):
            continue
        tgt = st.get("target") or {}
        target = geo.resolve(tgt.get("place"), tgt.get("country"), tgt.get("lat"), tgt.get("lon"))
        if not target:
            continue
        org = st.get("origin") or {}
        origin = geo.resolve(org.get("place"), org.get("country"), org.get("lat"), org.get("lon")) if org else None
        weapon = st.get("weapon") if st.get("weapon") in WEAPONS else "other"
        src = None
        for aid in st.get("article_ids") or []:
            if aid in art:
                src = art[aid]
                break
        date = str(st.get("date") or "")[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            continue

        def _int(v):
            try:
                return int(v) if v is not None else None
            except (TypeError, ValueError):
                return None

        cur = con.execute(
            "INSERT OR IGNORE INTO strikes(conflict_id,date,weapon,origin_name,origin_lat,origin_lon,origin_country,"
            "origin_precision,target_name,target_lat,target_lon,target_country,target_precision,launched,intercepted,"
            "outcome,link,title,source,created,attacker) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (conflict_id, date, weapon,
             origin and origin["name"], origin and origin["lat"], origin and origin["lon"],
             origin and origin["country"], origin and origin["precision"],
             target["name"], target["lat"], target["lon"], target["country"], target["precision"],
             _int(st.get("launched")), _int(st.get("intercepted")), (st.get("outcome") or "")[:300],
             src and src["link"], src and src["title"], src and src["source"], int(time.time()),
             (st.get("attacker") or "")[:80] or None))
        n += cur.rowcount
    return n


SEA = re.compile(r"\b(sea|strait|gulf|ocean|waters|channel|bay|coast|maritime|canal|offshore|island)s?\b", re.I)


def fix_epicenter(c: dict) -> dict:
    """Keep the model's epicenter only if it lies in a combatant country; otherwise
    resolve its label through the gazetteer or fall back to the main combatant's centroid."""
    ep = c.get("epicenter") or {}
    parties = c.get("parties") or []
    combat = [p.get("country") for p in parties if p.get("role") == "combatant" and p.get("country")]
    hosts = combat or [p.get("country") for p in parties if p.get("country")]
    lat, lon = ep.get("lat"), ep.get("lon")
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        lat = lon = None
    if lat is not None and SEA.search(ep.get("label") or ""):
        return c  # maritime epicenters (straits, seas, gulfs) legitimately sit outside any country
    if lat is not None:
        for cc in hosts:
            iso = geo.countries.iso3(cc)
            if iso and geo.point_in_country(lon, lat, iso, pad=0.75):
                return c
    for cc in hosts:
        r = geo.resolve(ep.get("label"), cc, None, None)
        if r and r["precision"] == "city":
            c["epicenter"] = {"lat": r["lat"], "lon": r["lon"], "label": ep.get("label") or r["name"], "fixed": "city"}
            return c
    if hosts:
        r = geo.resolve(None, hosts[0])
        if r:
            c["epicenter"] = {"lat": r["lat"], "lon": r["lon"], "label": ep.get("label") or r["name"], "fixed": "country"}
    return c


def run_batch(limit: int = ARTICLES_PER_BATCH) -> int:
    with db() as con:
        rows = con.execute(
            "SELECT id, link, source, title, summary, published FROM articles "
            "WHERE processed=0 ORDER BY published DESC LIMIT ?", (limit,)).fetchall()
        existing = all_conflicts(con)
    if not rows:
        return 0
    items = []
    for r in rows:
        day = datetime.fromtimestamp(r["published"], timezone.utc).strftime("%Y-%m-%d")
        items.append(f"[{r['id']}] ({r['source']}, {day}) {r['title']} — {r['summary']}")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    user = (
        "EXISTING CONFLICTS:\n" + json.dumps(_compact_existing(existing), ensure_ascii=False)
        + "\n\nNEW NEWS ITEMS:\n" + "\n".join(items)
    )
    log.info("extracting from %d articles (%d existing conflicts)", len(rows), len(existing))
    t0 = time.time()
    text = call_llm([
        {"role": "system", "content": SYSTEM.replace("{today}", today)},
        {"role": "user", "content": user},
    ])
    with db() as con:
        set_state(con, "last_raw", {"at": int(time.time()), "text": text[:60000]})
    try:
        result = _parse_json(text)
    except Exception:  # noqa: BLE001
        log.error("bad JSON from model (%d chars): %.300s", len(text), text)
        with db() as con:
            set_state(con, "last_error", {"at": int(time.time()), "text": text[:2000]})
            # park these articles (processed=3) so the batch is not retried forever
            con.executemany("UPDATE articles SET processed=3 WHERE id=?", [(r["id"],) for r in rows])
        return 0
    conflicts = [c for c in result.get("conflicts", []) if _valid(c)]
    by_id = {c["id"]: c for c in existing}
    art = {r["id"]: dict(r) for r in rows}
    n_strikes = 0
    with db() as con:
        for c in conflicts:
            prev = by_id.get(c["id"], {})
            fix_epicenter(c)
            # sources: keep unique links from cited article ids
            sources = {s["link"]: s for s in prev.get("sources", [])}
            for d in c.get("developments", []):
                for aid in d.get("article_ids", []) or []:
                    a = art.get(aid)
                    if a:
                        sources[a["link"]] = {"link": a["link"], "title": a["title"],
                                              "source": a["source"], "published": a["published"]}
                        d.setdefault("sources", []).append(a["link"])
            c["sources"] = sorted(sources.values(), key=lambda s: -s["published"])[:20]
            c["developments"] = sorted(
                c.get("developments", []), key=lambda d: d.get("date", ""), reverse=True)[:8]
            c["last_seen"] = int(time.time())
            c["first_seen"] = prev.get("first_seen", int(time.time()))
            strikes = c.pop("strikes", None) or []
            upsert_conflict(con, c["id"], c)
            n_strikes += _store_strikes(con, c["id"], strikes, art)
        con.executemany("UPDATE articles SET processed=1 WHERE id=?", [(r["id"],) for r in rows])
        set_state(con, "last_extract", {"at": int(time.time()), "articles": len(rows),
                                        "conflicts": len(conflicts), "strikes": n_strikes,
                                        "secs": round(time.time() - t0)})
    log.info("updated %d conflicts, %d new strikes in %.0fs", len(conflicts), n_strikes, time.time() - t0)
    return len(conflicts)


def run_all(max_batches: int = 60) -> int:
    total = 0
    for _ in range(max_batches):
        n = run_batch()
        with db() as con:
            left = con.execute("SELECT COUNT(*) FROM articles WHERE processed=0").fetchone()[0]
        total += n
        if left == 0:
            break
    return total
