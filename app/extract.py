"""Turn unprocessed articles into structured conflict records via the local LLM."""
import json
import logging
import re
import time
from datetime import datetime, timezone

import httpx

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
  ]
}}

Rules:
- Parties: list the direct combatants first. A "supporter" must provide material support to one side (arms, money, troops, bases, intelligence). A country that merely comments, sanctions, hosts talks or denies a visa is NOT a supporter; use "mediator" only for active negotiation hosts. Include supporters when the news or well-established public knowledge supports it (e.g. USA/EU states arming Ukraine, Iran arming the Houthis). Use ISO 3166-1 alpha-3 codes (e.g. UKR, RUS, ISR, PSE, IRN, USA, GBR, SDN, YEM, COD). Non-state actors get "country": null but still belong to a side.
- Keep records COMPLETE on every update: return the full merged party list, the full consequence list (keep prior items still true, add new ones, drop stale ones), and the 6 most recent developments (prior ones plus new ones).
- Be factual and neutral. Cite the article ids that support each development. Never invent developments not in the batch.
- Dates: use the article's date. Today is {{today}}.
- Output valid JSON only, no markdown fences, no commentary."""


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


def _parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise


def call_llm(messages: list[dict]) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 12000,
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
    try:
        result = _parse_json(text)
    except Exception:  # noqa: BLE001
        log.error("bad JSON from model: %.500s", text)
        with db() as con:
            set_state(con, "last_error", {"at": int(time.time()), "text": text[:2000]})
        return 0
    conflicts = [c for c in result.get("conflicts", []) if _valid(c)]
    by_id = {c["id"]: c for c in existing}
    art = {r["id"]: dict(r) for r in rows}
    with db() as con:
        for c in conflicts:
            prev = by_id.get(c["id"], {})
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
            upsert_conflict(con, c["id"], c)
        con.executemany("UPDATE articles SET processed=1 WHERE id=?", [(r["id"],) for r in rows])
        set_state(con, "last_extract", {"at": int(time.time()), "articles": len(rows),
                                        "conflicts": len(conflicts), "secs": round(time.time() - t0)})
    log.info("updated %d conflicts in %.0fs", len(conflicts), time.time() - t0)
    return len(conflicts)


def run_all(max_batches: int = 20) -> int:
    total = 0
    for _ in range(max_batches):
        n = run_batch()
        with db() as con:
            left = con.execute("SELECT COUNT(*) FROM articles WHERE processed=0").fetchone()[0]
        total += n
        if left == 0:
            break
    return total
