# Conflict Map

A fully local, news-driven world map of current armed conflicts: who is fighting,
who is backing whom, and what the consequences are.

## How it works

1. **GDELT** – every 15 minutes GDELT publishes a global event file. We keep the
   "material conflict" events (CAMEO quad class 4) for the last 48 h and use them as
   a background heat layer (per-country fill + heatmap) and for actor-pair links.
2. **RSS feeds** – BBC, Al Jazeera, Guardian, NYT, DW, France 24, UN News,
   Kyiv Independent, Times of Israel (see `app/config.py`).
3. **Local LLM extraction** – unprocessed articles go to `gpt-oss-120b` on llama-swap
   (`http://127.0.0.1:8080/v1`) in batches of 40, together with the existing conflict
   records. The model returns updated/new conflict records: parties (side + role),
   consequences by category, latest developments with source citations, an epicenter.
4. **Map** – MapLibre GL with vendored Natural Earth polygons (no external tiles).
   Conflict markers sized by severity and coloured by status; dashed arcs from
   supporters/mediators to the epicenter; click a conflict to highlight its parties.

5. **Strikes** – the model also lists strikes reported in each batch (weapon, origin,
   target, launched/intercepted counts, outcome, source). Place names are resolved
   through a local gazetteer (`static/data/places.geojson`, Natural Earth 10m
   populated places, ~7,300 cities); the model's own coordinates are only accepted
   when they fall inside the named country, otherwise the strike snaps to the country
   centroid with precision `country`. Precision is `city`, `approx` or `country` and is
   shown in the UI. On the map each strike replays as an animated projectile along a
   bent trajectory with an impact flash; a day slider filters to one day.

Everything lives in `data/conflict.db` (SQLite). Nothing leaves the machine except
the fetches to GDELT and the RSS feeds.

## Run

```bash
uv sync
uv run uvicorn app.server:app --host 127.0.0.1 --port 8765
# open http://127.0.0.1:8765
```

The server refreshes every 30 min (`REFRESH_MINUTES`). Trigger a refresh manually
with the Refresh button or `curl -X POST localhost:8765/api/refresh`.

Run the pipeline by hand:

```bash
uv run python -m app.pipeline            # GDELT + feeds + LLM extraction
uv run python -m app.pipeline --skip-llm # just fetch data
```

Env vars: `LLM_BASE`, `LLM_MODEL`, `GDELT_BACKFILL_HOURS` (48), `GDELT_WINDOW_HOURS`,
`REFRESH_MINUTES` (30), `ARTICLES_PER_BATCH` (40).

## Notes / known limits

- GDELT is noisy and English-media-biased (the US always glows). The heat layer
  only uses CAMEO root codes 19/20 (fight, mass violence) and a power curve, but it
  is still a rough "attention" signal, not a casualty count.
- The LLM decides what counts as a conflict; the prompt excludes crime, politics and
  diplomatic disputes but it will occasionally over-reach. Every development cites
  the article it came from so claims can be checked.
- Conflicts are never deleted automatically. `last_seen` is stored; stale ones can be
  filtered in the UI later.
